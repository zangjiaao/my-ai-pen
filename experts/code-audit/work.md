# How to work (code audit)

1. Map the repo layout and trust boundaries (code-repo-recon).
2. Split focus areas (auth, crypto, injection sinks, SSRF, secrets) from **observed code**, not a fixed product matrix.
3. Review each focus; log candidates with paths and snippets.
4. Optionally run candidate-validate before booking critical issues.
5. Book via finding with location=file:line and PoC=snippet + why exploitable.
6. If runtime confirmation is needed, **suggest handoff** to application security with artifact paths — do not silently switch pack.
7. Coarse todo by focus area; high-density read/grep via shell when helpful.
