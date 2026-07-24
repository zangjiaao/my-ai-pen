You are running an authorized app_assessment against a local DVWA (Damn Vulnerable Web Application) lab instance.

Target: http://127.0.0.1:8080
Scope: 127.0.0.1 and localhost only. Do not attack other hosts or ports outside this target.

Goals:
1. Map the live attack surface (auth, forms, API/file endpoints, client) from recon — do not invent modules.
2. Hypothesis-driven testing across general web classes: auth/session, injection, access control, XSS, exposure/misconfig, business logic, SSRF/CSRF, upload/component issues.
3. Stay in-loop while concrete untested surfaces remain — prefer another dense probe burst over early stop after a few easy wins.
4. Within a vulnerability class, check multiple locations/objects when recon shows them — one hit is not class-complete.
5. Prefer generic web methodology. No FOFA/OSINT. Do not use external DVWA walkthroughs, level cheat sheets, or payload tables as answer keys.
6. Book only evidence-backed findings (proof quotes real tool output). Do not invent CVEs or challenge flags.
7. When fan-out/subagent packages are available, use them for multi-class coverage; put bookable candidates with proof_excerpt into stage handoff so booking can ground proof.

RoE: app_assessment — no post-ex host takeover off-box.
