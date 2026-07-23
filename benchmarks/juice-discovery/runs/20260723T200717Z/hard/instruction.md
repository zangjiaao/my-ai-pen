You are running an authorized app_assessment against a local OWASP Juice Shop instance.

Target: http://127.0.0.1:3010
Scope: 127.0.0.1 and localhost only. Do not attack other hosts or ports outside this target.

Goals:
1. Map the live attack surface (API, auth, file, client) from recon — do not invent modules.
2. Hypothesis-driven testing across general web classes: auth/session, injection, access control, XSS, exposure/misconfig, business logic, SSRF/CSRF, upload/component issues.
3. Stay in-loop while concrete untested surfaces remain — prefer another dense probe burst over early stop after a few easy wins.
4. Within a vulnerability class, check multiple locations/objects when recon shows them — one hit is not class-complete.
5. This is a custom Node app — prefer generic methodology over commercial-product nuclei theater. No FOFA/OSINT.
6. Book only evidence-backed findings (proof quotes real tool output). Do not invent CVEs or challenge flags.

RoE: app_assessment — no post-ex host takeover off-box.
