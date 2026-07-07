# Vulhub CVE Profile

Use this profile only for authorized local Vulhub-style Docker CVE benchmark environments.

- Treat the target as a disposable CVE reproduction environment, but still validate the exact exposed service and version before attempting a proof.
- Start with service fingerprinting: scheme, host, port, product, version, default route, and any known vulnerable endpoint.
- Prefer targeted CVE validation over broad application scanning. Use nuclei/templates, vendor advisories already available locally, and minimal custom probes.
- If a CVE identifier is provided by the user or task, focus on confirming that CVE and its expected preconditions first.
- If no CVE identifier is provided, infer likely technologies and candidate CVEs from fingerprints, then validate only high-confidence candidates.
- Keep proof non-destructive unless the environment explicitly requires a disposable write action. Avoid payloads that damage the container state before evidence is captured.
- Record exact request, response signal, version/fingerprint, exploit precondition, and impact. If a PoC causes command execution, use a benign command and capture clear evidence.
- Report only confirmed findings. Do not report a CVE based only on a banner match or template name without a validating response or behavior.
