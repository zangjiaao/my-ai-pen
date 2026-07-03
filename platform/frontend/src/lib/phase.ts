export const PHASES = ["intake", "recon", "analysis", "verify", "report", "complete"] as const;

export const PHASE_LABELS: Record<string, string> = {
  intake: "\u76ee\u6807\u4e0e\u6388\u6743\u8303\u56f4\u68c0\u67e5",
  recon: "\u653b\u51fb\u9762\u53d1\u73b0",
  analysis: "\u8986\u76d6\u5206\u6790\u4e0e\u6d4b\u8bd5\u8ba1\u5212",
  verify: "\u9a8c\u8bc1\u4e0e\u8bc1\u636e\u786e\u8ba4",
  report: "\u62a5\u544a\u6574\u7406",
  complete: "\u4efb\u52a1\u5b8c\u6210",
};

export function phaseLabel(phase: unknown, fallback = "\u7b49\u5f85\u5f00\u59cb"): string {
  const key = String(phase || "").trim();
  if (!key) return fallback;
  return PHASE_LABELS[key] || key;
}