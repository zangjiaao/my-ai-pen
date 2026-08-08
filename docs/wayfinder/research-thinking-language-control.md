# Research: Controlling the Language of Model Thinking / Reasoning

**Date:** 2026-08-09  
**Status:** Read-only industry/research survey (not product claims)  
**Scope:** Whether model providers, research, and agent ecosystems discuss *forcing or controlling the natural language of a model’s thinking/reasoning process* (chain-of-thought, extended thinking, reasoning tokens, “thinking shown in chat”), **separately from** final-answer language.

---

## Question (restated)

Does the industry / research community / model providers discuss **forcing or controlling the natural language of a model’s thinking/reasoning process**, especially as a control surface distinct from final answer language?

Product motivation (context only, not treated as evidence): agents often inject system-prompt locale policies so chat replies follow operator locale (e.g. zh-CN); in practice final answers and todos may comply while **thinking/reasoning streams remain English** (or another dominant training language). Soft prompt assembly alone may be insufficient. Looking for industry evidence: forcing thinking language, bilingual CoT, target-language reasoning, or treating CoT as English-only internals.

---

## Executive summary

- **No major provider API exposes a first-class parameter to force the natural language of reasoning/thinking blocks.** Public controls cover *how much* the model thinks (effort, budget, level), whether thinking is on/off, and whether summaries or encrypted traces are returned—not *in which language* those traces are written. (OpenAI, Anthropic, Google Gemini, DeepSeek, xAI docs surveyed.)
- **Final answer language and thinking language are decoupled in practice.** Users and developers report final answers in the user’s language while reasoning summaries / thinking streams stay English (OpenAI community) or switch to Chinese (DeepSeek, some Claude Code reports). Providers do not document a reliable fix.
- **Research explicitly studies “think in English, answer in X” as a *deliberate design*** for better multilingual reasoning—not as a UX bug to fix. English-pivoted CoT, En-CoT vs Target-CoT, and xCoT-style methods treat intermediate reasoning language as a controllable *training/prompting* choice with accuracy tradeoffs.
- **DeepSeek is the clearest primary-source discussion of CoT language control:** R1-Zero mixes English/Chinese in thinking; R1 adds a **language consistency reward on CoT** (proportion of target-language words), accepting a slight accuracy drop for readability. Official docs still note language mixing for non-CN/EN queries.
- **Anthropic interpretability** frames internal computation as a cross-lingual “language of thought,” with English often mechanistically privileged; visible CoT is not guaranteed to match internals. This undermines the idea that prompt-only “think in language L” fully steers true reasoning language.
- **Forcing single-language thinking can reduce capability.** Time reporting on DeepSeek: when researchers forced the model to stick to one language for readability, problem-solving performance diminished.
- **Implications for soft language policy:** system prompts that set reply locale are widely used for (a) final answers; they are **not a documented, reliable API for (b) thinking language**. Treat thinking-language UX as a product presentation problem (hide, summarize, translate post hoc) or a model/training concern—not as something soft prompt assembly alone is known to guarantee.

---

## Distinctions used throughout

| Label | Meaning |
| --- | --- |
| **(a) Final answer language control** | User-visible `content` / reply text matches operator or user locale |
| **(b) CoT / thinking language control** | Language of internal reasoning tokens, extended thinking blocks, or streamed “thought process” UI |
| **(c) Hard post-processing** | Translate or rewrite thinking after generation (or hide it); does not change how the model reasoned |

This survey focuses on (b), with notes where (a) and (c) are the only available levers.

---

## Findings by source cluster

### 1. Model provider APIs and docs

#### OpenAI (reasoning models, Responses API)

- **What is controlled:** `reasoning.effort` (and related modes) guides *how much* to think; interleaved thinking; reasoning token counts; optional reasoning summaries for UX. Docs describe reasoning tokens as tokens used to “think” before/around the response.  
  - Guide: https://developers.openai.com/api/docs/guides/reasoning  
  - Azure mirror (explicit): “Reasoning tokens never appear in the message content, but they occupy space in the context window and are billed as output tokens.”  
    https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning
- **Language of reasoning:** **Not documented as an API field.** Official guides discuss effort, mode, cost, and context preservation—not `reasoning_language` or equivalent.
- **Community evidence that (a) and (b) diverge:**
  - Developers report **reasoning summaries streamed in English** while the assistant answer is French; request a `reasoning_language` parameter or auto-detect conversation language.  
    https://community.openai.com/t/reasoning-summaries-should-be-send-in-the-language-of-the-user/1362614  
  - Another thread: ChatGPT UI can show thinking summaries in browser language (e.g. Spanish) while the final answer follows the prompt language (French), while the **Responses API** with French system/user still emits **English** reasoning summaries—asking whether language control is possible.  
    https://community.openai.com/t/is-it-possible-to-control-the-language-of-thinking-summaries/1374184  
  - Separate discussion: reasoning summary content is largely **system-determined**; prompts are not documented as a way to mandate summary structure/content.  
    https://community.openai.com/t/how-to-specify-what-information-must-appear-in-the-reasoning-summaries/1371095
- **Press / secondary:** Reports that o1 sometimes “thinks” in Chinese (emergent, not a documented control).  
  Example coverage: https://medium.com/the-generator/openais-o1-model-prefers-to-think-in-chinese-here-s-why-6992b0403049  
  (Treat as anecdote unless tied back to OpenAI system cards; OpenAI official docs do not productize this.)

**Bottom line (OpenAI):** Controls depth of reasoning and visibility of *summaries*, not natural language of reasoning. Soft prompts for answer language do not reliably set summary language in the API.

#### Anthropic (Claude extended / adaptive thinking)

- **What is controlled:** Thinking enablement, token budgets (manual / legacy), adaptive thinking; thinking content blocks vs final text; on newer models, **summarized** thinking rather than raw tokens in some paths.  
  - https://platform.claude.com/docs/en/build-with-claude/extended-thinking  
  - Product writeup: https://www.anthropic.com/research/visible-extended-thinking  
  - Bedrock: thinking blocks for internal reasoning before final response.  
    https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html
- **Language of thinking:** **No official API parameter for thinking language** found in public extended-thinking docs.
- **Interpretability (primary research, not API):**
  - Anthropic asks explicitly: *“Claude can speak dozens of languages. What language, if any, is it using ‘in its head’?”*  
  - Finding: Claude sometimes thinks in a **shared conceptual space across languages** (“language of thought”); shared features across English/French/Chinese; more sharing at larger scale.  
    https://www.anthropic.com/research/tracing-thoughts-language-model  
    Full paper: https://transformer-circuits.pub/2025/attribution-graphs/biology.html  
  - Same work: written CoT can be **unfaithful** (bullshitting, motivated reasoning); visible steps may not match internal computation.
  - “On the Biology of a Large Language Model” also discusses English as mechanistically privileged in multilingual graphs (“Do Models Think in English?” section).  
    https://transformer-circuits.pub/2025/attribution-graphs/biology.html
- **Community / product UI:** Viral reports of Claude Code / Opus showing Chinese fragments in thinking UI (“thinking process” headers in Chinese while body English)—anecdotal UX leaks, not documented controls.  
  e.g. Reddit/social discussion: https://www.reddit.com/r/claude/comments/1szfv1n/claude_opus_thinks_in_chinese/

**Bottom line (Anthropic):** Extended thinking is budget/visibility controlled. Research suggests internal reasoning is not simply “English string generation,” and visible CoT language is not guaranteed to equal true computation language. No API to force thinking NL.

#### Google / Gemini (thinking / thought summaries)

- **What is controlled:** Dynamic thinking; `thinking_level` / budgets; thought **summaries** vs encrypted **signatures**; streaming of thought steps.  
  https://ai.google.dev/gemini-api/docs/thinking  
  Enterprise: https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking
- **Language of thinking:** Docs describe summaries of internal reasoning and control of *amount* of thinking. **No parameter found for thinking language.** Thought signatures are encrypted internal state—not human-language CoT to localize.

**Bottom line (Gemini):** Same pattern—effort/summary/signature, not language of thought text.

#### DeepSeek (R1 / thinking mode) — strongest primary discussion of CoT language

- **API:** Thinking mode on/off and effort; CoT returned as `reasoning_content` separate from `content`.  
  https://api-docs.deepseek.com/guides/thinking_mode/  
  **No `thinking_language` parameter** in public thinking-mode docs.
- **Training paper (primary):** DeepSeek-R1 / R1-Zero  
  https://arxiv.org/abs/2501.12948 (HTML: https://arxiv.org/html/2501.12948v1)  
  Nature version: https://www.nature.com/articles/s41586-025-09422-z  

  Key claims (paraphrased with close quotes from paper/Nature writeups):

  - R1-Zero: poor readability and **language mixing** (English + Chinese in a single CoT).
  - R1: *“During the training process, we observe that CoT often exhibits language mixing… To mitigate the issue of language mixing, we introduce a **language consistency reward** during RL training, which is calculated as the **proportion of target language words in the CoT**.”*
  - Ablation: language consistency → **slight degradation in performance**, better human readability.
  - Limitation: *“DeepSeek-R1 is at present optimized for Chinese and English, which may result in language-mixing issues when handling queries in other languages. For instance, DeepSeek-R1 might use English for reasoning and responses, even if the query is in a language other than English or Chinese.”* (Nature article / product summaries of same research.)
- **Press on tradeoff of forcing language:** TIME reports that when researchers **forced** the model to stick to one language for readability, **ability to solve problems diminished**—framing legibility of CoT as a performance tax and a safety-monitoring concern.  
  https://time.com/7210888/deepseeks-hidden-ai-safety-warning/
- **Community UX:** Non-Chinese users report the model **thinking in Chinese** on English questions.  
  e.g. https://eu.36kr.com/en/p/3579563285969799  

**Bottom line (DeepSeek):** Only major lab that publicly engineers **CoT language consistency as a training reward**, acknowledges mixing, and documents English/Chinese bias. Still **no inference-time API to force thinking language**; forcing single language is known to trade off accuracy.

#### xAI (Grok reasoning)

- **What is controlled:** `reasoning_effort` (low/medium/high); summarized reasoning content for streaming; encrypted reasoning content for continuity.  
  https://docs.x.ai/developers/model-capabilities/text/reasoning  
- **Language:** Sample reasoning output in docs is English. **No documented control for reasoning natural language.**

**Bottom line (xAI):** Effort + summary/encryption only.

#### Cross-provider pattern

| Provider | Effort / budget | Show / summarize thinking | Force thinking *language* |
| --- | --- | --- | --- |
| OpenAI | Yes (`reasoning.effort`, modes) | Summaries (not full tokens for many models) | **No documented API** |
| Anthropic | Yes (budget / adaptive) | Thinking blocks / summaries | **No documented API** |
| Google Gemini | Yes (`thinking_level` / budget) | Thought summaries + signatures | **No documented API** |
| DeepSeek | Yes (effort + toggle) | Full `reasoning_content` | **No inference API; training-time language reward** |
| xAI | Yes (`reasoning_effort`) | Reasoning summary stream | **No documented API** |

---

### 2. Research papers (CoT language choice, cross-lingual reasoning)

These sources treat **reasoning language as an experimental variable**, often *preferring English CoT for accuracy* while allowing non-English I/O.

#### English-centric / “do models think in English?”

- **Schut et al., “Do Multilingual LLMs Think In English?”** (arXiv:2502.15603)  
  https://arxiv.org/abs/2502.15603 · https://arxiv.org/html/2502.15603v1  
  Claim direction: key decisions occur in a representation space **closest to English**, independent of input/output language; reasoning is English-centric in a way **not transparent to users**.
- **Anthropic biology / tracing thoughts** (above): shared multilingual concept space; English often privileged; CoT faithfulness limited.
- **Wendler et al. / related “Llamas work in English” line** (cited widely, e.g. arXiv:2402.10588 family): latent English bias in middle layers.

#### Deliberate “think in English, answer in target language”

- **Tran et al., “Scaling Test-time Compute for Low-resource Languages”** (arXiv:2504.02890)  
  https://arxiv.org/abs/2504.02890 · https://arxiv.org/html/2504.02890v1  
  - Explicit method: **English-Pivoted CoT Training** — generate CoT in **English**, final response in **target language**, input in low-resource language.  
  - Outperforms training CoT+answer all in the target language (reported gains up to ~28%).  
  - Motivation: reasoning is stronger in the model’s dominant language; non-English CoT can fail understanding/reasoning.
- **Long Chain-of-Thought Reasoning Across Languages** (arXiv:2508.14828)  
  https://arxiv.org/html/2508.14828v2  
  - Compares **En-CoT** (target-language input, English reasoning) vs **Target-CoT** (input + long CoT in target language).  
  - Explicitly decomposes performance into understanding language vs **reasoning language**.
- **CL-CoT / non-English code generation** (e.g. PACLIC 2025 PDF cited in search): English CoT prompts with non-English instructions to encourage **reason in English, generate code**.
- **xCoT / cross-lingual CoT instruction tuning** (arXiv:2401.07037 and AAAI follow-ons):  
  https://arxiv.org/abs/2401.07037  
  Frameworks for cross-lingual CoT reasoning via instruction tuning.
- **AdaMCoT / AdaCoT** (arXiv:2501.16154): adaptive multilingual CoT routing through intermediate “thinking languages” before target-language answers.  
  https://arxiv.org/html/2501.16154v1  
  Example pattern in literature: intermediate reasoning in English (or selected pivot languages), final answer in user language.
- **Cross-lingual Prompting (CLP)** for zero-shot CoT across languages (EMNLP 2023):  
  https://aclanthology.org/2023.emnlp-main.163/
- **Cross-ToT** (cross-lingual tree-of-thoughts alignment): parallel CoT across languages.  
  https://arxiv.org/html/2311.08097v3

**Research consensus (evidence-based, not product advice):**

1. Intermediate reasoning language is a **first-class research variable**.  
2. Many methods **intentionally keep CoT in English** for quality, while localizing only the final answer (**b** ≠ **a** by design).  
3. Forcing Target-CoT (reasoning in the user’s language) can **hurt** accuracy for lower-resource languages.  
4. This is the inverse of a pure UX goal (“thinking UI should match locale”)—papers often optimize accuracy over thinking UI language.

---

### 3. Agent frameworks / coding agents / product UI

- **Cursor / Claude Code / Codex-class agents:** Public provider docs and community chatter discuss showing thinking panels, effort levels, and cost—not a first-party “thinking language = UI locale” setting. Community posts describe **mismatch** (English or Chinese thinking while chat is another language) rather than a solved control.
- **OpenAI Agents / Responses streaming:** Reasoning summaries are a first-class stream for agent UX; community still lacks language control (see OpenAI forum links above).
- **Practical framing in agent products:** Thinking is often treated as **debug/transparency chrome** (English-heavy by default), while the user-facing answer is localized—aligned with research’s English-pivot CoT pattern, even if accidental.

No first-party Cursor/Claude Code documentation was found that claims deterministic control of thinking-panel language independent of model defaults.

---

### 4. Community workarounds and practical patterns

Observed patterns (mostly informal; reliability varies):

| Pattern | Layer | What it does | Limits |
| --- | --- | --- | --- |
| System/user prompt: “Reply in zh-CN” | Soft (a) | Often steers final answer | Frequently **fails** to fully localize thinking/summaries (OpenAI forum) |
| Prompt: “Think in Chinese / Think in English then answer in X” | Soft (b attempt) | Sometimes steers **visible** CoT on open models; mixed on closed reasoning models | Research: internal representations may stay English-centric; some authors call “think in English, answer in L” **mostly wasted** for modern models if goal is capability rather than UI (developer commentary citing interpretability) |
| Hide thinking / disable thinking | Product / API | Removes language mismatch from UI | Loses transparency; some models cannot fully disable reasoning |
| Post-translate thinking stream | **(c)** | UX localization without changing model internals | Cost/latency; may misrepresent true reasoning; faithfulness already weak |
| Bilingual body: English reasoning + local summary | Hybrid | Matches English-pivot research | Requires product UX design |
| Training/RL language consistency reward | Model training | DeepSeek-style CoT language alignment | Slight accuracy cost; not available as customer API |
| Language steering vectors (research) | Mech interp / experimental | Steer output language features | Not product APIs |

DeepSeek’s own training narrative is the clearest “workaround that worked at scale”: **reward CoT language consistency during RL**, not prompt-only.

TIME’s reporting underscores a second community/research tension: **forcing single-language CoT can reduce problem-solving ability**—so “force thinking language for UX” may conflict with “maximize reasoning quality.”

---

## Implications for soft prompt-only language policy

Evidence-based, product-neutral:

1. **Soft language policies are documented/industry-validated primarily for (a) final answers**, not for (b) reasoning traces. Providers market and document answer behavior under normal chat alignment; reasoning is a separate channel (hidden tokens, summaries, or `reasoning_content`) with **its own defaults**.
2. **Provider APIs do not offer a reliable contract** that “system locale ⇒ thinking language.” Where users need localized thinking UI today, industry practice is closer to **(c)** (hide, summarize, or translate presentation) or to **accepting English (or CN/EN) thinking**.
3. **Research actively recommends English intermediate reasoning** for many multilingual tasks. A product that *successfully* forces thinking into a low-resource language might **regress** reasoning quality—matching DeepSeek’s ablation (language consistency reward vs accuracy) and English-pivoted CoT papers.
4. **Prompt assembly that puts “Standing language policy first”** addresses the same soft channel used for chat; it does not address:
   - server-side reasoning summary generation that ignores system language (OpenAI community reports);
   - training priors that mix or prefer CN/EN in CoT (DeepSeek);
   - latent English-centric computation (interpretability papers).
5. **Honest gap for builders:** If thinking is shown to operators in chat, treat language of thinking as a **presentation policy** (show raw / show translated / don’t show) unless the underlying model offers a language-consistency training story. Do not assume soft prompts alone close the gap.

---

## Gaps / open questions

1. **Do any providers ship a private/preview `reasoning_language` parameter?** Public docs for OpenAI, Anthropic, Gemini, DeepSeek, xAI (as of this survey date) do not. Community feature requests exist for OpenAI; no official “shipped” answer found.
2. **Are ChatGPT UI thinking summaries language-controlled by account/browser locale only?** Community reports suggest UI and API behavior differ; official documentation of the heuristic was not found.
3. **How much can soft prompts move visible CoT language on closed reasoning models vs open distillates?** Systematic public evals of “force thinking language via prompt” on o-series / Claude thinking / Gemini thought summaries are sparse; papers mostly study open or self-hosted long-CoT setups.
4. **Faithfulness vs language:** Even if visible thinking is forced into language L, interpretability work suggests it may still be post-hoc narrative. Localizing unfaithful CoT does not guarantee localizing true computation.
5. **Safety monitoring tradeoff:** If models gain capability by escaping human-language CoT (Meta continuous thoughts; DeepSeek language mixing under pure outcome RL), industry pressure may move *away* from legible multilingual CoT—further reducing the chance of stable thinking-language APIs.
6. **Bilingual operators (e.g. zh-CN product, English tooling):** No standard industry pattern for “thinking English for quality, todos/answers zh-CN for operators” is published as a product guideline; research supports the accuracy side of that split but not a single UX standard.

---

## Source list (URLs)

### Provider docs & primary product research

- OpenAI Reasoning models guide — https://developers.openai.com/api/docs/guides/reasoning  
- Azure OpenAI reasoning how-to — https://learn.microsoft.com/en-us/azure/foundry/openai/how-to/reasoning  
- Anthropic extended thinking docs — https://platform.claude.com/docs/en/build-with-claude/extended-thinking  
- Anthropic visible extended thinking — https://www.anthropic.com/research/visible-extended-thinking  
- Anthropic tracing thoughts — https://www.anthropic.com/research/tracing-thoughts-language-model  
- Anthropic / Transformer Circuits biology paper — https://transformer-circuits.pub/2025/attribution-graphs/biology.html  
- AWS Bedrock Claude extended thinking — https://docs.aws.amazon.com/bedrock/latest/userguide/claude-messages-extended-thinking.html  
- Google Gemini thinking API — https://ai.google.dev/gemini-api/docs/thinking  
- Google Cloud thinking models — https://docs.cloud.google.com/gemini-enterprise-agent-platform/models/thinking  
- DeepSeek Thinking Mode API — https://api-docs.deepseek.com/guides/thinking_mode/  
- xAI Reasoning docs — https://docs.x.ai/developers/model-capabilities/text/reasoning  

### Papers & formal publications

- DeepSeek-R1 arXiv — https://arxiv.org/abs/2501.12948 · HTML https://arxiv.org/html/2501.12948v1  
- DeepSeek-R1 Nature — https://www.nature.com/articles/s41586-025-09422-z  
- Do Multilingual LLMs Think In English? — https://arxiv.org/abs/2502.15603 · HTML https://arxiv.org/html/2502.15603v1  
- Scaling Test-time Compute for Low-resource Languages (English-Pivoted CoT) — https://arxiv.org/abs/2504.02890 · HTML https://arxiv.org/html/2504.02890v1  
- Long CoT Across Languages — https://arxiv.org/html/2508.14828v2  
- xCoT — https://arxiv.org/abs/2401.07037  
- AdaCoT / AdaMCoT — https://arxiv.org/html/2501.16154v1  
- Cross-lingual Prompting (EMNLP 2023) — https://aclanthology.org/2023.emnlp-main.163/  
- Cross-ToT — https://arxiv.org/html/2311.08097v3  
- Classic CoT (Wei et al.) — https://arxiv.org/abs/2201.11903  

### Community, press, secondary (use carefully)

- OpenAI forum: reasoning summaries language — https://community.openai.com/t/reasoning-summaries-should-be-send-in-the-language-of-the-user/1362614  
- OpenAI forum: control language of thinking summaries — https://community.openai.com/t/is-it-possible-to-control-the-language-of-thinking-summaries/1374184  
- OpenAI forum: controlling reasoning summary content — https://community.openai.com/t/how-to-specify-what-information-must-appear-in-the-reasoning-summaries/1371095  
- TIME on DeepSeek language mixing / force-language accuracy tradeoff — https://time.com/7210888/deepseeks-hidden-ai-safety-warning/  
- DeepSeek English Q / Chinese thinking (press) — https://eu.36kr.com/en/p/3579563285969799  
- Interconnects on DeepSeek language consistency rewards — https://www.interconnects.ai/p/deepseek-r1-recipe-for-o1  
- Claude thinking-in-Chinese discussions (anecdotal) — https://www.reddit.com/r/claude/comments/1szfv1n/claude_opus_thinks_in_chinese/  

---

## One-line takeaway

**Industry and research discuss thinking language extensively as training dynamics, accuracy tradeoffs, and UX mismatch—but providers do not ship APIs to force thinking language; research often prefers English CoT with localized answers; soft prompt locale policies are not a documented substitute for that missing control.**
