"""Shared task-shape classification for child-agent orchestration."""

from __future__ import annotations

import re
from typing import Literal


TaskShape = Literal["reporting", "validation", "discovery", "focused"]


_REPORTING_NAME_RE = re.compile(r"\breport(?:er|ing)?\b")
_VALIDATION_RE = re.compile(r"\b(?:validate|validator|validation|verify|reproduce|confirm|confirmation|poc|proof)\b")
_DISCOVERY_RE = re.compile(r"\b(?:discover|discovery|explore|enumerate|crawl|map|mapping|recon|reconnaissance|test|testing)\b")
_NEGATED_REPORT_RE = re.compile(
    r"\b(?:do\s+not|don't|not|never|without|no)\b"
    r"(?:\W+\w+){0,6}?"
    r"\W+(?:create_vulnerability_report|report|reports|reporting|vulnerability\s+report)"
)
_EXPLICIT_REPORT_RE = re.compile(
    r"(?:\bcreate_vulnerability_report\b|"
    r"\b(?:create|file|submit|write|produce|document|call|use)\b(?:\W+\w+){0,6}?"
    r"\W+(?:vulnerability\s+)?report\b|"
    r"\breport\b(?:\W+\w+){0,4}?\W+(?:confirmed\s+)?(?:finding|vulnerability|issue)\b)"
)


def classify_child_task_shape(*, name: str | None, task: object) -> TaskShape:
    """Classify child work without treating generic "report back" as reporting."""
    clean_name = str(name or "").lower()
    clean_task = str(task or "").lower()
    text = " ".join(f"{clean_name} {clean_task}".split())
    task_negates_reporting = bool(_NEGATED_REPORT_RE.search(clean_task))

    if _REPORTING_NAME_RE.search(clean_name) and not task_negates_reporting:
        return "reporting"
    if _EXPLICIT_REPORT_RE.search(text) and not task_negates_reporting:
        return "reporting"
    if _VALIDATION_RE.search(text):
        return "validation"
    if _DISCOVERY_RE.search(text):
        return "discovery"
    return "focused"


def task_purpose_for_shape(shape: TaskShape) -> str:
    if shape == "reporting":
        return "report"
    if shape == "validation":
        return "validate"
    if shape == "discovery":
        return "discover"
    return "test"
