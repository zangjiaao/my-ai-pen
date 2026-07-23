# Research: Juice write-up corpus → offline rubric principles (R1 + X1)

**Ticket:** [#31](https://github.com/zangjiaao/my-ai-pen/issues/31)  
**Map:** [#30 Wayfinder: Juice Shop discovery capability route (decision package)](https://github.com/zangjiaao/my-ai-pen/issues/30)  
**Branch:** `research/juice-writeup-rubric-principles`  
**Date:** 2026-07-23  
**Scope:** **Offline curated rubric principles only** — what the frozen third-party write-up corpus can inform for human-curated R1/X1 scoring. **No product code**, no runtime gates, no scoreboard completion product bar.

---

## 0. Explicit red line (read first)

**None of the challenge names, payloads, routes, flag sequences, in/out tables, or example paths in this note may be copied into product prompts, expert packs, harness gates, coverage validators, or runtime checklists.**

Product authority already forbids answer keys:

| Source | Rule (paraphrased; do not weaken) |
|--------|-----------------------------------|
| [`docs/prd.md`](../prd.md) §2.7 | 无靶场答案键 — do not drive runtime or prompts from DVWA/Juice/CTF flag lists |
| [`docs/prd.md`](../prd.md) §4.3 / §6 | No benchmark case tables in prompts or runtime gates; lab is offline对照, not “must clear official scoreboard” |
| [`AGENTS.md`](../../AGENTS.md) Harness Over Restriction | No target-specific profiles, expected vuln counts, fixed vuln lists, or site-ID logic to simulate ability; prefer harness steering over late gates |
| [`AGENTS.md`](../../AGENTS.md) | `research/` is frozen third-party reference (not product); `benchmarks/` is lab eval only |

**Intended use of this note:** humans curate an **offline** rubric (R1 principles + X1 example-class mapping) that scores *capability categories* and *discovery process quality* when reviewing lab runs. The write-up tree is a **source of taxonomy**, not an answer key to ship.

---

## 1. Corpus shape

**Primary tree read:** `research/Juice-Shop-Write-up/` (frozen under `research/`; gitignored as third-party snapshot).

| Path | Role |
|------|------|
| [`research/Juice-Shop-Write-up/README.md`](../../research/Juice-Shop-Write-up/README.md) | Community CTF write-up index: purpose, structure, full challenge list with official categories |
| `1-star/` … `6-stars/` | One markdown write-up per challenge, grouped by Juice Shop difficulty stars |
| `assets/` | Screenshots / diagrams referenced by write-ups |
| `files/` | Artifacts downloaded during solves (logs, backups, easter egg blobs, keys, etc.) |
| `tools/` | Solver scripts, wordlists, **achievements backup** (progression auto-validate) |

### 1.1 Star folders and counts

| Folder | Write-ups (`.md` counted on disk 2026-07-23) |
|--------|-----------------------------------------------|
| `1-star/` | 14 |
| `2-stars/` | 14 |
| `3-stars/` | 19 |
| `4-stars/` | 22 |
| `5-stars/` | 17 |
| `6-stars/` | 12 |
| **Total challenge write-ups** | **~98** |

README challenge list tracks the same set (minor filename drift vs README links, e.g. on-disk `login_mcsafesearch.md` vs README `login_mc_safesearch.md`). Corpus is **not claimed complete** by upstream (“some remain not completed”).

### 1.2 README purpose (as stated)

From the corpus README (read in full):

- **What it is:** Unofficial community repository of **step-by-step Juice Shop CTF solutions**, vulnerability descriptions, and remediations — companion to [OWASP Juice Shop companion guide](https://pwning.owasp-juice.shop/companion-guide/latest/).
- **Structure intent:** Difficulty folders + tools + assets + files; optional `all_achievements.json` backup that **auto-validates most challenges** when applied (explicit CTF progression cheat artifact).
- **Pedagogy:** “Self-attempt before reference”; write-ups are **spoilers by design**.

### 1.3 Write-up internal shape (sample pattern)

Each challenge markdown typically has: **Title / Category / Difficulty** → Tools → step-by-step Methodology (often with **exact payloads, routes, account emails, seeds**) → Remediation. Examples read end-to-end or in substantial part:

- Include-shaped: `2-stars/login_admin.md`, `2-stars/view_basket.md`, `1-star/dom_xss.md`, `1-star/confidential_document.md`, `3-stars/payback_time.md`, `5-stars/unsigned_jwt.md`, `6-stars/ssrf.md`, `6-stars/ssti.md`
- Exclude-shaped: `1-star/scoreboard.md`, `4-stars/easter_egg.md`, `4-stars/nested_easter_egg.md`, `2-stars/nft_takeover.md`, `1-star/web3_interface.md`, `3-stars/bjoern_favorite_pet.md`, `6-stars/imaginary_challenge.md`, `4-stars/steganography.md`, `5-stars/extra_language.md`

---

## 2. Draft **exclude** classes (offline rubric: do not treat as product web-pentest capability)

These classes are useful CTF toys or Juice-specific scoreboard fiction. Offline rubric should **de-weight or drop** them when measuring real-scenario web discovery capability (R1/X1). Examples are **illustrative for curators only**.

### 2.1 Scoreboard / CTF meta / progression fiction

Challenges whose main goal is finding the **scoreboard**, “imaginary” challenges, or validating CTF progression rather than a customer-relevant vuln class.

| Examples (paths under `research/Juice-Shop-Write-up/`) | Why exclude |
|--------------------------------------------------------|-------------|
| `1-star/scoreboard.md` | Hidden route to scoreboard page; CTF UI meta |
| `6-stars/imaginary_challenge.md` | Meta “challenge that is not a challenge”; ContinueCode / hashid archaeology |
| `tools/` achievements backup (see README “Achievements Backup”) | Auto-complete progression — pure answer-key infrastructure |

### 2.2 Easter eggs, nested puzzles, stego, pure obscurity paths

Hidden files, ROT13/Base64 nest eggs, image stego, “find the funny path” without a transferable app-sec finding story.

| Examples | Why exclude |
|----------|-------------|
| `4-stars/easter_egg.md` | `/ftp` easter egg + null-byte toy file download |
| `4-stars/nested_easter_egg.md` | Base64 → ROT13 hidden path narrative |
| `4-stars/steganography.md` | Carousel image stego / OpenStego-style CTF |
| `3-stars/privacy_policy_inspection.md` | Security-through-obscurity inspection puzzle (per README category) |

### 2.3 Web3 / NFT / blockchain toys

Wallet seed phrases, NFT takeover, mint honey pot, wallet depletion, blockchain hype — not default B2B web assessment surface for this product’s offline Juice discovery rubric.

| Examples | Why exclude |
|----------|-------------|
| `1-star/web3_interface.md` | Discover `#/web3-sandbox` |
| `2-stars/nft_takeover.md` | Seed phrase in feedback → NFT private key |
| `2-stars/meta_geostaking.md` / `2-stars/visual_geostaking.md` | Geo-staking / photo-wall CTF flavor (paired Web3 theme) |
| `3-stars/mint_the_honey_pot.md` | Web3 mint / improper validation toy |
| `5-stars/blockchain_hype.md` | Blockchain/security-through-obscurity hype challenge |
| `6-stars/wallet_depletion.md` | Crypto wallet depletion |

### 2.4 Pure CTF character-login / lore OSINT narratives

Challenges that amount to “log in as named fictional character X” via lore, fandom, social OSINT on real people, or one-off password trivia — **not** general authz/authn methodology (contrast with JWT none / SQLi login as *technique* classes in §3).

| Examples | Why exclude (as *capability target*) |
|----------|--------------------------------------|
| `3-stars/login_amy.md` | Character credential / crypto-trivia login narrative |
| `3-stars/login_bender.md` / `4-stars/login_bender.md` | Character-specific login series |
| `4-stars/login_bjoern.md` / `4-stars/login_uvogin.md` | Named-account CTF ladder |
| `3-stars/bjoern_favorite_pet.md` | OSINT pet name for security question (external social) |
| `3-stars/reset_jim_password.md` / `5-stars/reset_morty_password.md` / `5-stars/reset_bjoern_password.md` | Character password-reset lore chains |
| `2-stars/login_mcsafesearch.md` | OSINT / meme character login |

**Nuance for curators:** the *technique* behind a character login (e.g. SQLi in `2-stars/login_admin.md` or `3-stars/login_jim.md`) can still inform an **injection** include class; the **named-account trophy list** must not become a runtime or rubric “must pwn Jim/Amy/Bender” checklist.

### 2.5 Juice-only gimmicks & non-web-assessment noise

Localization easter languages, chatbot bullying, “zero stars” UI gimmicks, premium paywall crypto toys, etc., when they do not map cleanly to a real engagement deliverable.

| Examples | Why exclude / de-weight |
|----------|-------------------------|
| `5-stars/extra_language.md` | Hidden i18n locale CTF |
| `1-star/bully_chatbot.md` / `5-stars/kill_chatbot.md` | Chatbot annoyance / kill logic gimmick |
| `1-star/zero_star.md` | Rating UI gimmick |
| `1-star/mass_dispel.md` / `1-star/missing_encoding.md` | Juice-specific UI/encoding toys (weak real-world signal unless reframed as input validation generically) |
| `6-stars/premium_paywall.md` | Paywall / access gimmick with CTF framing |
| `2-stars/weird_crypto.md` / `4-stars/legacy_typosquatting.md` | Crypto/typosquat trivia with weak general pentest transfer unless reframed carefully |

### 2.6 Corpus support artifacts (never product inputs)

| Artifact | Risk if misused |
|----------|-----------------|
| `files/*` (e.g. `eastere.gg`, `coupons_2013.md.bak`, `incident-support.kdbx`) | Drop-in spoilers |
| `tools/wordlists`, solver scripts | Payload/answer automation |
| README full challenge list + categories | Ready-made “expected vuln inventory” if pasted into gates |

---

## 3. Draft **include** classes (real-scenario web capability categories)

**Categories first.** Offline rubric (R1 principles) should score whether an agent *discovers and evidences* work in these classes on a live Juice (or similar) target — **not** whether it hits named challenges. Example write-ups below are **curator mapping only** (X1: illustrative anchors → capability class).

### 3.1 Authentication & session integrity

Password/session/token weaknesses that matter on real apps (weak auth, JWT misconfig, 2FA bypass patterns, session handling).

| Example write-ups (curator anchors) | Capability signal |
|------------------------------------|-------------------|
| `2-stars/password_strength.md` | Weak password / auth policy |
| `5-stars/unsigned_jwt.md` | JWT `alg=none` / signature not verified |
| `6-stars/forged_signed_jwt.md` | JWT/crypto component abuse |
| `5-stars/two_factor_authentification.md` | 2FA bypass class |
| `5-stars/change_bender_password.md` | Authn state change without proper checks (technique, not character list) |

### 3.2 Injection (SQL / NoSQL / template / command-adjacent)

Server-side injection families with transferable methodology.

| Example write-ups | Capability signal |
|-------------------|-------------------|
| `2-stars/login_admin.md` | Classic login SQLi |
| `3-stars/login_jim.md` / `3-stars/database_schema.md` | SQLi → auth / schema disclosure |
| `4-stars/christmas_special.md` / `4-stars/user_credentials.md` / `4-stars/ephemeral_accountant.md` | Injection-led discovery |
| `4-stars/nosql_manipulation.md` / `4-stars/nosql_dos.md` / `5-stars/nosql_exflitration.md` | NoSQL injection / abuse |
| `6-stars/ssti.md` | Server-side template injection |
| `5-stars/local_file_read.md` | Server-side injection → LFI-style read |
| `4-stars/poison_null_bytes.md` | Path/extension filter bypass (injection-adjacent) |

### 3.3 Access control (IDOR / privilege / horizontal-vertical)

Broken object/function level authorization — high value for real pentest.

| Example write-ups | Capability signal |
|-------------------|-------------------|
| `2-stars/view_basket.md` | Basket IDOR |
| `2-stars/admin_section.md` / `3-stars/admin_registration.md` | Privileged surface / role registration |
| `3-stars/forged_feedback.md` / `3-stars/forged_review.md` | Forged identity on user content |
| `3-stars/manipulate_basket.md` / `3-stars/product_tampering.md` | Object-level control on commerce objects |
| `4-stars/allowlist_bypass.md` | Redirect/allowlist control failure |
| `2-stars/five_star_feedback.md` | Admin/moderation ACL |

### 3.4 Cross-site scripting (and related client injection)

DOM / reflected / header / stored-adjacent XSS patterns.

| Example write-ups | Capability signal |
|-------------------|-------------------|
| `1-star/dom_xss.md` | DOM XSS via search/`iframe` |
| `2-stars/reflected_xss.md` | Reflected XSS |
| `1-star/bonus_payload.md` | XSS payload class |
| `4-stars/server_side_xss_protection.md` / `4-stars/x_header_xss.md` | XSS filter bypass / header XSS |
| `6-stars/video_xss.md` | Media/upload XSS path |

### 3.5 Sensitive data exposure & misconfiguration

Public backups, metrics, logs, error leakage, forgotten interfaces — common real findings.

| Example write-ups | Capability signal |
|-------------------|-------------------|
| `1-star/confidential_document.md` | Open directory / confidential doc on `/ftp` |
| `1-star/exposed_metrics.md` | Metrics endpoint exposure |
| `1-star/error_handling.md` | Verbose errors |
| `2-stars/depreceted_interface.md` | Deprecated/misconfigured interface |
| `4-stars/access_log.md` / `5-stars/leaked_access_log.md` | Log exposure |
| `4-stars/forgotten_sales_backup.md` / `4-stars/gdpr_data_theft.md` | Backup / personal data exposure |
| `5-stars/email_leak.md` | Misconfiguration → email leak |
| `5-stars/retrieve_blueprint.md` | Information disclosure class |

### 3.6 Business logic & anti-automation

Price/quantity/coupon/order flow abuse; captcha/automation gaps with commerce impact.

| Example write-ups | Capability signal |
|-------------------|-------------------|
| `3-stars/payback_time.md` | Price/accounting logic abuse |
| `3-stars/deluxe_fraud.md` | Paid-tier fraud / validation skip |
| `4-stars/expired_coupon.md` / `6-stars/forged_coupon.md` | Coupon/business-rule bypass |
| `3-stars/captcha_bypass.md` / `6-stars/multiples_likes.md` | Anti-automation weakness |

### 3.7 SSRF, CSRF, and server-side request abuse

| Example write-ups | Capability signal |
|-------------------|-------------------|
| `6-stars/ssrf.md` | SSRF via profile image URL |
| `3-stars/csrf.md` / `5-stars/cross_site_imaging.md` | CSRF / cross-site request patterns |

### 3.8 Upload, deserialization, vulnerable components, RCE-class

File upload limits/bypass, insecure deserialization, known-bad library chains — when framed as *class* not CVE bingo list.

| Example write-ups | Capability signal |
|-------------------|-------------------|
| `3-stars/upload_size.md` | Upload validation weakness |
| `5-stars/frontend_typosquatting.md` / `5-stars/blocked_rce_dos.md` / `6-stars/successful_rce_dos.md` | Deserialization / RCE-DoS class |
| `6-stars/arbitrary_file_write.md` | Vulnerable component → write |
| `4-stars/vulnerable_library.md` / `5-stars/supply_chain_attack.md` | Component/supply-chain awareness (offline: process quality, not “must name library X”) |

### 3.9 Registration / input validation that maps to real onboarding abuse

Keep only when it generalizes (empty registration, role assignment, redirect allowlist) — not UI star-rating toys.

| Example write-ups | Capability signal |
|-------------------|-------------------|
| `2-stars/empty_user_registration.md` / `3-stars/admin_registration.md` | Registration validation / privilege via registration |
| `1-star/outdated_allowlist.md` / `4-stars/allowlist_bypass.md` | Open redirect / allowlist failures |
| `3-stars/gdpr_data_erasure.md` | Authn/account lifecycle edge (erasure) with security impact |

---

## 4. How this should feed **offline** R1 + X1 (and only that)

| Artifact | Role | Must not become |
|----------|------|-----------------|
| **R1 — principles** | Human rubric: score discovery process + evidence quality on **include classes** (§3); explicitly ignore or de-weight §2 classes | Prompt bullet list of Juice challenges |
| **X1 — example mapping** | Optional curator spreadsheet: write-up file → include/exclude class (this note is a **draft seed**, not frozen) | Runtime expected-findings table |
| Live Juice lab run | Engineering debug / offline对照 (`docs/prd.md` §6) | Product acceptance “% of scoreboard” |
| This markdown | Wayfinder research for map #30 | Source text for expert `work.md` / gates |

**Suggested offline scoring stance (non-normative draft for human freeze later):**

1. Prefer **breadth across include classes** and **evidence quality** over star-count or challenge-count.  
2. Credit **technique transfer** (e.g. SQLi methodology) even if the agent never touches a named character login.  
3. Do **not** penalize skipping easter eggs / Web3 / scoreboard meta.  
4. Never encode “N vulnerabilities expected” or fixed title lists into product harness.

---

## 5. Paths actually read (audit trail)

| Path | Use |
|------|-----|
| `research/Juice-Shop-Write-up/README.md` | Corpus purpose, structure, full challenge index |
| Star folder listings + counts for `1-star`…`6-stars` | ~98 write-up count |
| Samples: `1-star/{scoreboard,dom_xss,confidential_document,web3_interface,bully_chatbot}.md` | Meta / XSS / exposure / web3 / gimmick |
| Samples: `2-stars/{login_admin,view_basket,nft_takeover,meta_geostaking,white_hat}.md` | Injection / IDOR / NFT / OSINT |
| Samples: `3-stars/{login_jim,payback_time,bjoern_favorite_pet,forged_feedback}.md` | SQLi / business logic / lore OSINT / ACL |
| Samples: `4-stars/{easter_egg,nested_easter_egg,steganography,christmas_special,forgotten_sales_backup}.md` | Easter/stego / injection / exposure |
| Samples: `5-stars/{unsigned_jwt,extra_language,blockchain_hype}.md` | JWT / locale gimmick / blockchain |
| Samples: `6-stars/{ssrf,ssti,imaginary_challenge,wallet_depletion}.md` | SSRF/SSTI / meta / wallet |
| `research/Juice-Shop-Write-up/files/`, `tools/` (listing) | Spoiler artifact surface |
| `docs/prd.md` (principles §2, non-goals §4.3, acceptance §6) | No answer key / lab offline only |
| `AGENTS.md` (Harness Over Restriction + research freeze) | No fixed vuln lists; research not product |

---

## 6. Out of ticket / handoff

- **Human final freeze** of R1/X1 principles (this is draft).  
- **Map #30 Decisions** update: parent session, not this ticket.  
- **No** product implementation, no Juice run required for #31.  
- **Do not** promote any challenge list into `experts/`, `node4/`, or platform prompts.

---

## 7. One-line resolution

The Juice write-up corpus is a **~98-challenge, 1–6★ CTF spoiler library** useful only as an **offline taxonomy source**: exclude scoreboard/meta, easter/stego, Web3/NFT, character-lore logins, and gimmicks; include real web classes (auth, injection, access control, XSS, exposure, business logic, SSRF/CSRF, upload/component/RCE-class) — **never as a runtime answer key**.
