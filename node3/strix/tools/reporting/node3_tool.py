"""Node3-owned vulnerability reporting tool for the vendored Strix runtime."""

from __future__ import annotations

import json
import logging
import re
from pathlib import PurePosixPath
from typing import Any

from agents import RunContextWrapper, function_tool


logger = logging.getLogger(__name__)

_CVSS_VALID = {
    "attack_vector": ["N", "A", "L", "P"],
    "attack_complexity": ["L", "H"],
    "privileges_required": ["N", "L", "H"],
    "user_interaction": ["N", "R"],
    "scope": ["U", "C"],
    "confidentiality": ["N", "L", "H"],
    "integrity": ["N", "L", "H"],
    "availability": ["N", "L", "H"],
}
_CVSS_SHORT_TO_LONG = {
    "AV": "attack_vector",
    "AC": "attack_complexity",
    "PR": "privileges_required",
    "UI": "user_interaction",
    "S": "scope",
    "C": "confidentiality",
    "I": "integrity",
    "A": "availability",
}
_CVSS_IGNORED_KEYS = {"score", "severity", "E", "RL", "RC", "CR", "IR", "AR", "MAV", "MAC", "MPR", "MUI", "MS", "MC", "MI", "MA"}

_CODE_LOCATION_FIELDS = (
    "file",
    "start_line",
    "end_line",
    "snippet",
    "label",
    "fix_before",
    "fix_after",
)

_REQUIRED_FIELDS = {
    "title": "Title cannot be empty",
    "description": "Description cannot be empty",
    "impact": "Impact cannot be empty",
    "target": "Target cannot be empty",
    "technical_analysis": "Technical analysis cannot be empty",
    "poc_description": "PoC description cannot be empty",
    "poc_script_code": "PoC script/code is REQUIRED - provide the actual exploit/payload",
    "remediation_steps": "Remediation steps cannot be empty",
}


def _validate_file_path(path: str) -> str | None:
    if not path or not path.strip():
        return "file path cannot be empty"
    p = PurePosixPath(path)
    if p.is_absolute():
        return f"file path must be relative, got absolute: '{path}'"
    if ".." in p.parts:
        return f"file path must not contain '..': '{path}'"
    return None


def _normalize_code_locations(raw: list[dict[str, Any]] | None) -> list[dict[str, Any]] | None:
    if not raw:
        return None
    cleaned: list[dict[str, Any]] = []
    for loc in raw:
        normalized: dict[str, Any] = {}
        for field in _CODE_LOCATION_FIELDS:
            if field not in loc or loc[field] is None:
                continue
            value = loc[field]
            if field in ("start_line", "end_line"):
                try:
                    normalized[field] = int(value)
                except (TypeError, ValueError):
                    continue
            else:
                text = (
                    str(value).strip("\n")
                    if field in ("snippet", "fix_before", "fix_after")
                    else str(value).strip()
                )
                if text:
                    normalized[field] = text
        if normalized.get("file") and normalized.get("start_line") is not None:
            cleaned.append(normalized)
    return cleaned or None


def _validate_code_locations(locations: list[dict[str, Any]]) -> list[str]:
    errors: list[str] = []
    for i, loc in enumerate(locations):
        path_err = _validate_file_path(loc.get("file", ""))
        if path_err:
            errors.append(f"code_locations[{i}]: {path_err}")
        start = loc.get("start_line")
        if not isinstance(start, int) or start < 1:
            errors.append(f"code_locations[{i}]: start_line must be a positive integer")
        end = loc.get("end_line")
        if end is None:
            errors.append(f"code_locations[{i}]: end_line is required")
        elif not isinstance(end, int) or end < 1:
            errors.append(f"code_locations[{i}]: end_line must be a positive integer")
        elif isinstance(start, int) and end < start:
            errors.append(f"code_locations[{i}]: end_line ({end}) must be >= start_line ({start})")
    return errors


def _extract_cve(cve: str) -> str:
    match = re.search(r"CVE-\d{4}-\d{4,}", cve)
    return match.group(0) if match else cve.strip()


def _validate_cve(cve: str) -> str | None:
    if not re.match(r"^CVE-\d{4}-\d{4,}$", cve):
        return f"invalid CVE format: '{cve}' (expected 'CVE-YYYY-NNNNN')"
    return None


def _extract_cwe(cwe: str) -> str:
    match = re.search(r"CWE-\d+", cwe)
    return match.group(0) if match else cwe.strip()


def _validate_cwe(cwe: str) -> str | None:
    if not re.match(r"^CWE-\d+$", cwe):
        return f"invalid CWE format: '{cwe}' (expected 'CWE-NNN')"
    return None


def _json_object(value: Any) -> dict[str, Any] | None:
    if isinstance(value, dict):
        return value
    if isinstance(value, str) and value.strip():
        try:
            parsed = json.loads(value)
        except json.JSONDecodeError:
            return None
        return parsed if isinstance(parsed, dict) else None
    return None


def _cvss_vector_to_dict(value: str) -> dict[str, str] | None:
    text = value.strip()
    if not text.upper().startswith("CVSS:"):
        return None
    parts = text.split("/")
    parsed: dict[str, str] = {}
    for part in parts[1:]:
        if ":" not in part:
            continue
        key, raw_value = part.split(":", 1)
        long_key = _CVSS_SHORT_TO_LONG.get(key.upper())
        if long_key:
            parsed[long_key] = raw_value.upper()
    return parsed or None


def _normalize_cvss_breakdown(raw: Any) -> tuple[dict[str, str], list[str]]:
    errors: list[str] = []
    if isinstance(raw, str):
        vector = _cvss_vector_to_dict(raw)
        if vector is not None:
            return vector, []
        parsed = _json_object(raw)
        if parsed is not None:
            raw = parsed

    if not isinstance(raw, dict) or not raw:
        return {}, ["cvss_breakdown: must be an object with the 8 CVSS metrics"]

    if set(raw.keys()) == {"_json"}:
        wrapped = raw.get("_json")
        if isinstance(wrapped, str):
            vector = _cvss_vector_to_dict(wrapped)
            if vector is not None:
                return vector, []
        parsed = _json_object(wrapped)
        if parsed is None:
            return {}, ["cvss_breakdown._json: must contain a JSON object or CVSS vector"]
        raw = parsed

    normalized: dict[str, str] = {}
    for key, value in raw.items():
        if value is None:
            continue
        key_text = str(key)
        long_key = _CVSS_SHORT_TO_LONG.get(key_text.upper()) or key_text
        if long_key in _CVSS_VALID:
            normalized[long_key] = str(value).strip().upper()
        elif key_text not in _CVSS_IGNORED_KEYS and key_text.upper() not in _CVSS_IGNORED_KEYS:
            errors.append(f"Unknown cvss_breakdown metric: {key_text}")

    for name, valid in _CVSS_VALID.items():
        value = normalized.get(name)
        if value not in valid:
            errors.append(f"Invalid {name}: {value}. Must be one of: {valid}")
    return normalized, errors


def _calculate_cvss(breakdown: dict[str, str]) -> tuple[float, str, str]:
    try:
        from cvss import CVSS3

        vector = (
            f"CVSS:3.1/AV:{breakdown['attack_vector']}/AC:{breakdown['attack_complexity']}/"
            f"PR:{breakdown['privileges_required']}/UI:{breakdown['user_interaction']}/"
            f"S:{breakdown['scope']}/C:{breakdown['confidentiality']}/"
            f"I:{breakdown['integrity']}/A:{breakdown['availability']}"
        )
        c = CVSS3(vector)
        score = c.scores()[0]
        severity = c.severities()[0].lower()
    except Exception:
        logger.exception("Failed to calculate CVSS")
        return 7.5, "high", ""
    return score, severity, vector


async def _do_create(
    *,
    title: str,
    description: str,
    impact: str,
    target: str,
    technical_analysis: str,
    poc_description: str,
    poc_script_code: str,
    remediation_steps: str,
    cvss_breakdown: dict[str, Any] | str,
    endpoint: str | None,
    method: str | None,
    cve: str | None,
    cwe: str | None,
    code_locations: list[dict[str, Any]] | None,
    agent_id: str | None = None,
    agent_name: str | None = None,
) -> dict[str, Any]:
    errors: list[str] = []
    fields = {
        "title": title,
        "description": description,
        "impact": impact,
        "target": target,
        "technical_analysis": technical_analysis,
        "poc_description": poc_description,
        "poc_script_code": poc_script_code,
        "remediation_steps": remediation_steps,
    }
    for name, msg in _REQUIRED_FIELDS.items():
        if not str(fields.get(name) or "").strip():
            errors.append(msg)

    cvss_breakdown, cvss_errors = _normalize_cvss_breakdown(cvss_breakdown)
    errors.extend(cvss_errors)

    parsed_locations = _normalize_code_locations(code_locations)
    if parsed_locations:
        errors.extend(_validate_code_locations(parsed_locations))
    if cve:
        cve = _extract_cve(cve)
        cve_err = _validate_cve(cve)
        if cve_err:
            errors.append(cve_err)
    if cwe:
        cwe = _extract_cwe(cwe)
        cwe_err = _validate_cwe(cwe)
        if cwe_err:
            errors.append(cwe_err)

    if errors:
        return {"success": False, "error": "Validation failed", "errors": errors}

    cvss_score, severity, _vector = _calculate_cvss(cvss_breakdown)

    try:
        from strix.report.state import get_global_report_state

        report_state = get_global_report_state()
        if report_state is None:
            logger.warning("No global report state; vulnerability report not persisted")
            return {
                "success": True,
                "message": f"Vulnerability report '{title}' created (not persisted)",
                "warning": "Report could not be persisted - report state unavailable",
            }

        from strix.report.dedupe import check_duplicate

        existing = report_state.get_existing_vulnerabilities()
        candidate = {
            "title": title,
            "description": description,
            "impact": impact,
            "target": target,
            "technical_analysis": technical_analysis,
            "poc_description": poc_description,
            "poc_script_code": poc_script_code,
            "endpoint": endpoint,
            "method": method,
        }
        dedupe = await check_duplicate(candidate, existing)
        if dedupe.get("is_duplicate"):
            duplicate_id = dedupe.get("duplicate_id", "")
            duplicate_title = next(
                (r.get("title", "Unknown") for r in existing if r.get("id") == duplicate_id),
                "",
            )
            return {
                "success": True,
                "status": "skipped_duplicate",
                "message": (
                    f"Potential duplicate of '{duplicate_title}' "
                    f"(id={duplicate_id[:8]}...) - do not re-report the same vulnerability"
                ),
                "duplicate_of": duplicate_id,
                "duplicate_title": duplicate_title,
                "confidence": dedupe.get("confidence", 0.0),
                "reason": dedupe.get("reason", ""),
            }

        report_id = report_state.add_vulnerability_report(
            title=title,
            description=description,
            severity=severity,
            impact=impact,
            target=target,
            technical_analysis=technical_analysis,
            poc_description=poc_description,
            poc_script_code=poc_script_code,
            remediation_steps=remediation_steps,
            cvss=cvss_score,
            cvss_breakdown=cvss_breakdown,
            endpoint=endpoint,
            method=method,
            cve=cve,
            cwe=cwe,
            code_locations=parsed_locations,
            agent_id=agent_id if isinstance(agent_id, str) else None,
            agent_name=agent_name if isinstance(agent_name, str) else None,
        )
    except (ImportError, AttributeError) as exc:
        logger.exception("create_vulnerability_report persistence failed")
        return {"success": False, "error": f"Failed to create vulnerability report: {exc!s}"}

    logger.info(
        "Vulnerability report created: id=%s severity=%s cvss=%.1f title=%s",
        report_id,
        severity,
        cvss_score,
        title,
    )
    return {
        "success": True,
        "message": f"Vulnerability report '{title}' created successfully",
        "report_id": report_id,
        "severity": severity,
        "cvss_score": cvss_score,
    }


@function_tool(timeout=180, strict_mode=False)
async def create_vulnerability_report(
    ctx: RunContextWrapper,
    title: str,
    description: str,
    impact: str,
    target: str,
    technical_analysis: str,
    poc_description: str,
    poc_script_code: str,
    remediation_steps: str,
    cvss_breakdown: dict[str, Any] | str,
    endpoint: str | None = None,
    method: str | None = None,
    cve: str | None = None,
    cwe: str | None = None,
    code_locations: list[dict[str, Any]] | None = None,
) -> str:
    inner = ctx.context if isinstance(ctx.context, dict) else {}
    raw_agent_id = inner.get("agent_id")
    agent_id = raw_agent_id if isinstance(raw_agent_id, str) else None
    agent_name = None
    coordinator = inner.get("coordinator")
    if agent_id is not None and coordinator is not None:
        names = getattr(coordinator, "names", {})
        if isinstance(names, dict):
            raw_agent_name = names.get(agent_id)
            agent_name = raw_agent_name if isinstance(raw_agent_name, str) else None

    result = await _do_create(
        title=title,
        description=description,
        impact=impact,
        target=target,
        technical_analysis=technical_analysis,
        poc_description=poc_description,
        poc_script_code=poc_script_code,
        remediation_steps=remediation_steps,
        cvss_breakdown=cvss_breakdown,
        endpoint=endpoint,
        method=method,
        cve=cve,
        cwe=cwe,
        code_locations=code_locations,
        agent_id=agent_id,
        agent_name=agent_name,
    )
    return json.dumps(result, ensure_ascii=False, default=str)
