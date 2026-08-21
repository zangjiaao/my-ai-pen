/**
 * Public alias for ChoiceCard (Spec #312 / #450).
 * Authorize/handoff and next_steps share Approval wizard chrome.
 * Prefer importing ChoiceCard for new code; this re-export stays for API stability.
 */
export { default, type ApprovalDecision } from "./ChoiceCard";
