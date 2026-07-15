# Playbook B re-run — with `case_context` (work-group thread)

**Date:** 2026-07-16  
**Model:** deepseek-v4-flash  
**Change under test:** experts receive Case work-group **thread + findings board** on dispatch

| Station | Pack | Task | Booked | Drift? |
|---------|------|------|--------|--------|
| 2 v2 | code-audit | collab-b-s2-v2 | **3** (SQLi, IDOR, **SSRF**) | No live attack |
| 3 v2 | pentest | collab-b-s3-v2 | **3** (same three, verify plans) | **No** DVWA/Juice |

Compare to v1 (no case_context): station 3 booked **10** findings including ambient DVWA/Juice.

---

## What improved

1. **code-audit** todo opened with “Read handoff from pentest team” and used artifact paths from group context (short instruction, no long path paste required beyond hints).
2. **Static labels:** 3/3 private labels hit (SSRF confirmed this run).
3. **pentest** todo: *Verify SQLi / IDOR / SSRF* — consumed findings board, not full rescan.
4. **Scope discipline:** VERIFY_SUMMARY explicitly notes ports 8000/8080/3000 as **out of scope**; all candidates `blocked_no_target` on dead `:9`.
5. Instruction stayed short; context lived in `case_context`.

## Residual

- Booked finding `status` field may still show confirmed while narrative is blocked_no_target (booking honesty polish).
- Standalone still **simulates** platform thread; full platform path uses DB messages on real `task_assign`.
- Shared **disk** between tasks still separate; path hints + thread text carry the story.

## Verdict

**Collaboration is much smoother with work-group context.** Session/case now means something to the joining expert: they read the group, then act.
