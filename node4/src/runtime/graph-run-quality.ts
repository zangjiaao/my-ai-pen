/**
 * Spec #139 graph-run Product state — owned by hardGraphRun, not processQuality.
 * Prior seed, L1 refine accounting, validate_book unbookable, engagement close-out.
 */

import type { EngagementCloseout } from "./engagement-closeout.js";
import type { PriorSeedResult } from "./prior-seed.js";

export type GraphRunL1Stage = {
  /** L1 refine attempts already applied by the runner for this stage. */
  refine_n: number;
  last?: { decision: string; gaps: string[] };
};

export type GraphRunQualityState = {
  priorSeed?: PriorSeedResult;
  l1ByStage: Record<string, GraphRunL1Stage>;
  unbookable: Array<{ finding_id: string; reason: string }>;
  engagementCloseout?: EngagementCloseout;
};

export function createGraphRunQualityState(): GraphRunQualityState {
  return {
    l1ByStage: {},
    unbookable: [],
  };
}

/**
 * Ensure hardGraphRun.graphQuality exists. No-op when no hardGraphRun.
 * Prefer calling after hardGraphRun is installed on the lifecycle.
 */
export function ensureGraphRunQuality(
  hardGraphRun: { graphQuality?: GraphRunQualityState } | undefined | null,
): GraphRunQualityState | undefined {
  if (!hardGraphRun) return undefined;
  if (!hardGraphRun.graphQuality) {
    hardGraphRun.graphQuality = createGraphRunQualityState();
  }
  const gq = hardGraphRun.graphQuality;
  if (!gq.l1ByStage) gq.l1ByStage = {};
  if (!gq.unbookable) gq.unbookable = [];
  return gq;
}
