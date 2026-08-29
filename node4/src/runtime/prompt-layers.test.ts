/**
 * Prompt layers T1 — assembler seam + Default / Expert Free contracts (#387).
 * Run: npx tsx src/runtime/prompt-layers.test.ts
 */
import assert from "node:assert/strict";
import {
  assembleSystemPrompt,
  buildPromptLayers,
  buildSystemPrompt,
  type PromptLayers,
} from "./prompt.js";
import { DEFAULT_SEAT_PACK, PENTEST_ROLE_PACK } from "../roles/index.js";
import type { TaskEnvelope } from "../types.js";
import { formatGraphInjection, type ResolvedPentestGraph } from "./pentest-graph.js";

function ok(cond: unknown, msg: string): void {
  assert.ok(cond, msg);
  console.log("ok", msg);
}

const STANDING_HEADING = "## Standing node policies";

const baseTask: TaskEnvelope = {
  taskId: "t-layers",
  conversationId: "c-layers",
  instruction: "Assess authorized target",
  target: { type: "url", value: "http://example.test" },
  scope: { allow: ["example.test"] },
  engagement: "pentest",
  agentLanguage: "en",
};

// --- assembleSystemPrompt: order + empty omit ---
{
  const ordered = assembleSystemPrompt({
    base: "BASE_MARK",
    profession: "PROF_MARK",
    runtime: "RUN_MARK",
    task: "TASK_MARK",
  });
  assert.equal(
    ordered,
    "BASE_MARK\n\n## Profession\nPROF_MARK\n\n## Runtime\nRUN_MARK\n\n## This turn\nTASK_MARK",
    "assemble joins four layers with blank lines and later-layer headings",
  );
  ok(
    ordered.indexOf("BASE_MARK") < ordered.indexOf("PROF_MARK") &&
      ordered.indexOf("PROF_MARK") < ordered.indexOf("RUN_MARK") &&
      ordered.indexOf("RUN_MARK") < ordered.indexOf("TASK_MARK"),
    "assemble order Base → Profession → Runtime → Task",
  );

  const skipEmpty = assembleSystemPrompt({
    base: "BASE_ONLY",
    profession: "",
    runtime: "  ",
    task: "TASK_ONLY",
  });
  assert.equal(skipEmpty, "BASE_ONLY\n\n## This turn\nTASK_ONLY");
  ok(!skipEmpty.includes("PROF"), "empty profession omitted");
  ok(
    skipEmpty.indexOf("BASE_ONLY") < skipEmpty.indexOf("TASK_ONLY"),
    "omitting middle layers does not reorder remaining",
  );

  const allEmpty = assembleSystemPrompt({
    base: "",
    profession: "",
    runtime: "",
    task: "",
  });
  assert.equal(allEmpty, "");
  ok(true, "all-empty layers assemble to empty string");
}

// --- buildPromptLayers: Standing first in Base; layer markers ---
{
  const layers = buildPromptLayers(baseTask, PENTEST_ROLE_PACK);
  ok(layers.base.startsWith(STANDING_HEADING), "Base starts with Standing heading");
  ok(layers.base.includes("Role pack:"), "Base has Role pack meta");
  ok(
    layers.base.includes("Application security assessment"),
    "pack label keeps spaces (not Applicationsecurityassessment)",
  );
  ok(layers.base.includes("untrusted display label"), "Base has persona untrusted policy");
  ok(
    !layers.base.includes("Target:"),
    "Base does not own Task target JSON",
  );

  ok(layers.profession.length > 0, "Profession non-empty for Expert pack");
  ok(
    !layers.profession.includes("## Standing node policies"),
    "Profession does not re-emit Standing",
  );
  ok(
    !layers.profession.includes("### Work mode"),
    "Profession does not own Free work-mode tags",
  );

  ok(layers.runtime.includes("Tools:"), "Runtime has tools list");
  ok(layers.runtime.includes("Booking mode:"), "Runtime has booking mode");
  ok(PENTEST_ROLE_PACK.toolNames.includes("workset"), "pentest pack registers workset");
  ok(/workset tool/i.test(layers.runtime), "Runtime has workset gated one-liner (#532)");
  ok(!DEFAULT_SEAT_PACK.toolNames.includes("workset"), "default seat has no workset");
  ok(layers.runtime.includes("allow_postex"), "Runtime has RoE injection");
  ok(layers.runtime.includes("Stay in authorized scope."), "Runtime has scope stay line");
  ok(
    !layers.runtime.includes("Target:"),
    "Runtime does not own Task target JSON",
  );

  ok(layers.task.includes("Scope:"), "Task has authorized Scope");
  ok(
    layers.task.includes("only_if_default=true"),
    "Task assigns auto-title when placeholder + structured target",
  );
  const titled = buildPromptLayers(
    { ...baseTask, conversationTitle: "Juice Shop 复测" },
    PENTEST_ROLE_PACK,
  );
  ok(
    titled.task.includes("Juice Shop 复测") && !titled.task.includes("only_if_default=true"),
    "Task does not auto-title when the Case title is already custom",
  );
  ok(
    layers.task.includes("Scope allow:") || layers.task.includes("Scope:"),
    "Task has scope",
  );
  ok(layers.task.includes("Instruction:"), "Task has instruction");
  ok(
    !layers.task.includes("## Standing node policies"),
    "Task does not own Standing",
  );
}

// --- Full assemble: Standing-first + cross-layer order ---
{
  const freeWorkMode = formatGraphInjection({
    mode: "free",
    graphId: null,
    graph: null,
    allowPostex: false,
    mainAct: "delegate_preferred",
  } satisfies ResolvedPentestGraph);
  const layers = buildPromptLayers(baseTask, PENTEST_ROLE_PACK, {
    workModeInjection: freeWorkMode,
  });
  const prompt = assembleSystemPrompt(layers);
  // Parity: buildSystemPrompt facade matches assemble of layers
  assert.equal(
    buildSystemPrompt(baseTask, PENTEST_ROLE_PACK, {
      workModeInjection: freeWorkMode,
    }),
    prompt,
    "buildSystemPrompt equals assemble(buildPromptLayers)",
  );

  ok(prompt.startsWith(STANDING_HEADING), "full prompt Standing-first");
  const standingIdx = prompt.indexOf(STANDING_HEADING);
  const rolePackIdx = prompt.indexOf("Role pack:");
  const toolsIdx = prompt.indexOf("Tools:");
  const workModeIdx = prompt.indexOf("### Work mode");
  const scopeIdx = prompt.indexOf("Scope:");
  const instructionIdx = prompt.indexOf("Instruction:");

  ok(standingIdx === 0, "Standing at absolute start");
  ok(rolePackIdx > standingIdx, "Role pack after Standing (Base)");
  ok(toolsIdx > rolePackIdx, "Tools after Base meta");
  ok(workModeIdx > toolsIdx, "work-mode after capability header (Runtime)");
  ok(scopeIdx > workModeIdx, "Task Scope after Runtime work-mode");
  ok(prompt.includes("### Rules of engagement"), "RoE is markdown under Runtime");
  ok(
    !prompt.includes("<work-mode>") &&
      !prompt.includes("<rules-of-engagement>") &&
      !prompt.includes("<available-graphs>") &&
      !prompt.includes("<goal_context>"),
    "assembled system has no leftover XML prompt shells",
  );
  ok(instructionIdx > scopeIdx, "Instruction after Scope in Task");
  const profH = prompt.indexOf("## Profession");
  const runH = prompt.indexOf("## Runtime");
  const taskH = prompt.indexOf("## This turn");
  ok(profH > standingIdx && runH > profH && taskH > runH, "visible layer headings keep Base → Profession → Runtime → Task");

  // Profession (mission/work) sits between Base persona and Runtime tools
  const personaIdx = prompt.indexOf("untrusted display label");
  ok(
    personaIdx > standingIdx && personaIdx < toolsIdx,
    "persona policy in Base before Runtime tools",
  );

  ok(prompt.includes("Skills available"), "Expert Free lists skill ids");
  ok(
    /pentest-/i.test(prompt) || prompt.includes("Skills available"),
    "Expert Free skill surface present",
  );
  ok(prompt.includes("allow_postex"), "Expert Free has RoE");
  // #399: Runtime skill blurb is one never-bulk-load line (Profession owns progressive doctrine)
  ok(
    layers.runtime.includes("Never bulk-load skill bodies."),
    "T1 Runtime has short never-bulk-load skill line",
  );
  ok(
    !/skill\(op=list\) returns id\/name\/description only/i.test(layers.runtime),
    "T1 Runtime does not multi-sentence restatement of progressive skill (work.md home)",
  );
}

// --- Default: non-act / no finding(confirm) recon methodology ---
{
  const defaultTask: TaskEnvelope = {
    taskId: "t-default",
    conversationId: "c-default",
    instruction: "你好，有哪些资产？",
    target: {},
    scope: {},
    engagement: "default",
    expertName: "平台助理",
    agentLanguage: "zh-CN",
  };
  const layers = buildPromptLayers(defaultTask, DEFAULT_SEAT_PACK);
  const prompt = buildSystemPrompt(defaultTask, DEFAULT_SEAT_PACK);

  ok(prompt.startsWith(STANDING_HEADING), "Default Standing-first");
  ok(prompt.includes("平台助理"), "Default includes product persona");
  ok(
    prompt.includes("No shell, no finding(confirm), no recon.") ||
      prompt.includes("no finding(confirm)"),
    "Default non-act: no finding(confirm) recon",
  );
  ok(
    !prompt.includes("### Work mode"),
    "Default has no Free/Graph work-mode block",
  );
  ok(
    !prompt.includes("Hard Graph stage"),
    "Default never enters Expert Graph stage law",
  );
  ok(
    !layers.runtime.includes("### Work mode"),
    "Default Runtime omits work-mode injection",
  );
  // Default booking is none — not finding booking doctrine
  ok(
    layers.runtime.includes("Booking mode: none") ||
      prompt.includes("Booking mode: none"),
    "Default booking mode none",
  );
  ok(
    !prompt.includes("only_if_default=true"),
    "Default greeting / no-target turn does not assign auto-title",
  );
  // No Expert skill encyclopedia / progressive skill list unless pack declares skills
  ok(
    !DEFAULT_SEAT_PACK.skillIds?.length || !prompt.includes("Skills available"),
    "Default does not invent Expert skill surface",
  );
  ok(
    prompt.indexOf(STANDING_HEADING) < prompt.indexOf("Tools:"),
    "Default Base before Runtime tools",
  );
  ok(prompt.includes("Scope:"), "Default Task includes authorized Scope");
}

// --- Expert Free: workModeInjection free + skill ids ---
{
  const freeInjection = [
    "### Work mode",
    "mode: free",
    "Prefer Free continuity; do not invent Soft scenario Graph.",
  ].join("\n");
  const prompt = buildSystemPrompt(baseTask, PENTEST_ROLE_PACK, {
    workModeInjection: freeInjection,
  });
  ok(prompt.includes("### Work mode"), "Expert Free injects work-mode block");
  ok(prompt.includes("mode: free"), "Expert Free work-mode is free");
  ok(
    prompt.includes("Skills available") &&
      (prompt.includes("pentest-") || /skill/i.test(prompt)),
    "Expert Free skill ids appear",
  );
  ok(
    prompt.indexOf("## Standing node policies") < prompt.indexOf("### Work mode"),
    "Standing before Free work-mode",
  );
  ok(
    prompt.indexOf("### Work mode") < prompt.indexOf("Scope:"),
    "Free work-mode before Task envelope",
  );
  // No Soft product mode markers
  ok(
    !prompt.includes("Soft scenario") || prompt.includes("do not invent Soft"),
    "no Soft scenario product path (only negative mention if any)",
  );
}

// --- Layer keys are product vocabulary only (no L0–L5 public API) ---
{
  const sample: PromptLayers = buildPromptLayers(baseTask, PENTEST_ROLE_PACK);
  const keys = Object.keys(sample).sort().join(",");
  assert.equal(keys, "base,profession,runtime,task", "PromptLayers keys only four product layers");
  ok(true, "no L0–L5 public layer keys");
}

// --- RoE skill gating still on Expert path ---
{
  const assess = buildSystemPrompt(
    {
      ...baseTask,
      engagementTemplate: "app_assessment",
      allowPostex: false,
    },
    PENTEST_ROLE_PACK,
  );
  ok(
    assess.includes("allow_postex: false") || assess.includes("withheld"),
    "assessment postex gated via layered Runtime",
  );
}

// --- T2 (#388): Expert Free assembled prompt is thin (no Graph process longform) ---
{
  const freeWorkMode = formatGraphInjection({
    mode: "free",
    graphId: null,
    graph: null,
    allowPostex: false,
    mainAct: "delegate_preferred",
  } satisfies ResolvedPentestGraph);
  // Free Runtime block stays thin (mode + continuity + enter_graph + clarify; no stage dump).
  ok(freeWorkMode.includes("mode: free"), "T2 free injection mode: free");
  ok(
    /Prefer Free continuity|enter_graph|never silent/i.test(freeWorkMode),
    "T2 free injection continuity / enter_graph",
  );
  ok(
    /request_user_decision/.test(freeWorkMode) &&
      /legal entity|authorization|Scope/i.test(freeWorkMode),
    "T2 free injection: ask when identity/auth/Scope is insufficient",
  );
  ok(
    !/Stage settlement is host-owned|plan_node_id REQUIRED|Prefer packages over one long serial/i.test(
      freeWorkMode,
    ),
    "T2 free injection has no Graph settlement/packages longform",
  );
  ok(
    freeWorkMode.length < 800,
    `T2 free Runtime block slim (len=${freeWorkMode.length} < 800)`,
  );

  const layers = buildPromptLayers(baseTask, PENTEST_ROLE_PACK, {
    workModeInjection: freeWorkMode,
  });
  const prompt = assembleSystemPrompt(layers);

  // Absent: full Graph process-quality / host-settlement / formal package law on Free path
  ok(
    !/### Process quality \(Expert Graph/i.test(prompt),
    "T2 Free: no Process quality (Expert Graph) chapter",
  );
  ok(
    !/### Hypothesis work mode \(Expert Graph/i.test(prompt),
    "T2 Free: no Hypothesis work mode (Expert Graph) chapter",
  );
  ok(
    !/Stage settlement is host-owned/i.test(prompt),
    "T2 Free: no Stage settlement is host-owned longform",
  );
  ok(
    !/plan_node_id REQUIRED/i.test(prompt),
    "T2 Free: no plan_node_id REQUIRED formal-package law",
  );

  // Present: Free competence (proof bar / progressive skill / free work-mode)
  ok(
    /causality/i.test(prompt) &&
      /reproducibility/i.test(prompt) &&
      /impact/i.test(prompt),
    "T2 Free still has unified proof bar triad",
  );
  ok(
    /at most one/i.test(prompt) && /skill/i.test(prompt),
    "T2 Free still has progressive skill (at most one)",
  );
  ok(
    prompt.includes("mode: free") || /Free continuity|pure OMP/i.test(prompt),
    "T2 Free still has free work-mode",
  );
  ok(
    /enter_graph/i.test(prompt) || /enter-Graph|enter Graph/i.test(prompt),
    "T2 Free may still mention enter_graph briefly",
  );
  ok(
    /fact|surface/i.test(prompt) && /finding\(confirm\)/i.test(prompt),
    "T2 Free still has fact/surface vs finding separation",
  );
  ok(/deadend|bounded abandon|rotate/i.test(prompt), "T2 Free still has deadend/rotate");

  // Profession layer itself is the pack work body (mission+work) — no Graph process chapter
  ok(
    !/### Process quality \(Expert Graph/i.test(layers.profession),
    "T2 Profession layer has no Process quality Expert Graph chapter",
  );
  ok(
    !/Stage settlement is host-owned/i.test(layers.profession),
    "T2 Profession layer has no host-settlement longform",
  );
}

// --- T3 (#389): Expert Profession core slim + contract markers ---
{
  // work.md is the Expert profession how-to body (mission stays short; citizen may
  // still sit in missionLines until a later Base split). Budget pins workLines only.
  const workBody = PENTEST_ROLE_PACK.workLines.join("\n");
  const layers = buildPromptLayers(baseTask, PENTEST_ROLE_PACK);
  const prof = layers.profession;

  // §3.7 guidance: prefer ≤ ~2–3k always-on profession how-to; hard ceiling blocks god-file regrowth.
  ok(
    workBody.length < 4500,
    `T3 work.md profession core slim (len=${workBody.length} < 4500; guidance ~2–3k)`,
  );
  ok(
    !/kind=next_steps|todo_replace_permission|replace_todo_map|todo_replace_allowed/i.test(workBody),
    "T3 work.md does not restate Base next_steps / todo-replace long contracts",
  );
  ok(
    !/packages\[\]|plan_node_id REQUIRED|resume_agent_id|op=release/i.test(workBody),
    "T3 work.md has no Graph package / plan_node_id ceremony",
  );
  ok(
    !/### Process quality \(Expert Graph/i.test(workBody) &&
      !/Stage settlement is host-owned/i.test(workBody) &&
      !/### Hypothesis work mode \(Expert Graph/i.test(workBody),
    "T3 work.md free of Graph process longform (T2 retained)",
  );

  // §6 profession-core contract markers on assembled Profession (mission+work)
  ok(
    /at most one/i.test(prof) && /skill/i.test(prof),
    "T3 Profession: progressive skill load (at most one)",
  );
  ok(
    /causality/i.test(prof) &&
      /reproducibility/i.test(prof) &&
      /impact/i.test(prof),
    "T3 Profession: unified proof bar triad",
  );
  ok(
    /fact/i.test(prof) && /surface/i.test(prof) && /finding\(confirm\)/i.test(prof),
    "T3 Profession: fact/surface vs finding separation",
  );
  ok(/deadend|rotate/i.test(prof), "T3 Profession: deadend/rotate");
  ok(
    /Version or banner alone is not a finding/i.test(workBody) ||
      /version.*not a finding/i.test(workBody),
    "T3 work.md: version/banner alone is not a finding",
  );
  ok(
    /nuclei first|nuclei \/ searchsploit first/i.test(workBody),
    "T3 work.md: named-product nuclei-first pointer",
  );

  // #400: scientific recon + Surface v2 posture (profession core)
  ok(
    /Discovery order/i.test(workBody) && /real feature use/i.test(workBody),
    "T3 work.md: discovery order (reachable → real feature use → path hypotheses)",
  );
  ok(
    /full surface enum/i.test(workBody) &&
      /training-data|historical-vuln/i.test(workBody),
    "T3 work.md: bans prior-only path menus as full surface enum",
  );
  ok(
    /prefer.*http.*session.*browser|Prefer `http`\/`session`\/`browser`/i.test(workBody) &&
      /shell batch curl is \*\*supplement\*\*|shell batch curl is supplement/i.test(workBody),
    "T3 work.md: first-pass prefer http/session/browser; shell batch is supplement",
  );
  ok(
    /Traffic settle \+ TARGET seed/i.test(workBody) &&
      /upsert optional/i.test(workBody) &&
      /finding\(confirm\).*booked|booked/i.test(workBody),
    "T3 work.md: Surface v2 (Traffic settle + seed; upsert optional; confirm→booked)",
  );
  ok(
    /Guessed paths OK/i.test(workBody) && /real requests/i.test(workBody),
    "T3 work.md: guessed paths only with real requests",
  );

  // #411: NEW → TESTED coverage; priors ≠ this-Case TESTED / coverage complete
  ok(
    /surface\(op=mark\)/i.test(workBody) &&
      /\*\*untested\*\*[^*]*→\s*\*\*tested\*\*/i.test(workBody),
    "T3 work.md: untested → tested via surface(op=mark)",
  );
  ok(
    /priors/i.test(workBody) &&
      /≠ this-Case TESTED|≠ coverage complete/i.test(workBody),
    "T3 work.md: priors ≠ this-Case TESTED / ≠ coverage complete",
  );
  ok(
    /cannot invent identities/i.test(workBody) || /cannot write coverage/i.test(workBody),
    "T3 work.md: upsert cannot invent identities / write coverage",
  );
  ok(
    /Coverage honesty/i.test(workBody) &&
      /surface\(summary\)/i.test(workBody) &&
      /disclose remaining NEW untested/i.test(workBody),
    "T3 work.md: coverage honesty / disclose remaining NEW untested",
  );
  ok(
    /Todo map complete ≠ surface coverage complete/i.test(workBody),
    "T3 work.md: todo complete ≠ surface coverage complete",
  );
  ok(
    /never hard-blocks settlement/i.test(workBody) ||
      /Open NEW untested never hard-blocks/i.test(workBody),
    "T3 work.md: open NEW untested does not hard-block settlement",
  );
}

{
  const withHandoff: TaskEnvelope = {
    ...baseTask,
    instruction: "对目标：http://host.docker.internal:3000 再次进行渗透测试",
    handoffSummary: "**任务**: 去对 196 条台账做索引避免撞车",
  };
  const prompt = buildSystemPrompt(withHandoff, PENTEST_ROLE_PACK);
  ok(prompt.includes("### Handoff"), "authorized card body is This-turn ### Handoff");
  ok(
    prompt.includes("Authorized card body (not the operator utterance)"),
    "Handoff block is labeled not-utterance",
  );
  ok(prompt.includes("196 条台账"), "Handoff keeps the authorized card body");
  ok(
    prompt.includes("对目标：http://host.docker.internal:3000 再次进行渗透测试"),
    "operator utterance stays on the instruction line",
  );
}

{
  const plain = buildSystemPrompt(baseTask, PENTEST_ROLE_PACK);
  ok(
    !/todo\(init\)/i.test(plain),
    "eager todo is not in system unless the session asks for it",
  );
  const withReminders = buildSystemPrompt(baseTask, PENTEST_ROLE_PACK, {
    eagerTodo: true,
    eagerBooking: true,
  });
  ok(/todo\(init\)/i.test(withReminders), "eager todo reminder lives in Runtime when opted in");
  ok(withReminders.includes("### This-run todo"), "eager todo uses Runtime markdown heading");
  const chat = buildSystemPrompt(
    { ...baseTask, target: {}, scope: {} },
    PENTEST_ROLE_PACK,
    { chatOnly: true },
  );
  ok(
    /no execution burst/i.test(chat),
    "chat-only Runtime forbids recon burst without changing pentest into greeting",
  );

  const ledgerHostOnly = buildSystemPrompt(
    {
      ...baseTask,
      target: { type: "url", value: "http://example.test" },
      scope: { allow: ["example.test"] },
    },
    DEFAULT_SEAT_PACK,
    { chatOnly: true },
  );
  ok(
    ledgerHostOnly.includes("Scope in This turn is for handoff"),
    "ledger chat-only with host-only target names Target/Scope for handoff",
  );
  ok(
    !ledgerHostOnly.includes("Ledger Q&A and handoff only."),
    "host-only target is not the empty-engagement ledger line",
  );

  const ledgerDefaultPort = buildSystemPrompt(
    {
      ...baseTask,
      target: { type: "url", value: "https://example.test:443" },
      scope: { allow: ["https://example.test:443"] },
    },
    DEFAULT_SEAT_PACK,
    { chatOnly: true },
  );
  ok(
    ledgerDefaultPort.includes("Scope in This turn is for handoff"),
    "ledger chat-only with :443 still treats the engagement as named",
  );

  const ledgerEmpty = buildSystemPrompt(
    { ...baseTask, target: {}, scope: {} },
    DEFAULT_SEAT_PACK,
    { chatOnly: true },
  );
  ok(
    ledgerEmpty.includes("Ledger Q&A and handoff only."),
    "ledger chat-only without target stays Q&A/handoff",
  );
}

console.log("\nALL prompt-layers T1+T2+T3 tests passed");
