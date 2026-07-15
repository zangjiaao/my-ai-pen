---
name: alert-true-false-positive
description: Decide true vs false positive with evidence-backed reasoning.
---

# True / false positive

## When to load
- After enrichment, before closing or escalating an alert

## Process
1. State the alert’s hypothesis (what malicious behavior it claims).
2. Compare to available evidence (logs, payloads, red PoC, benign change windows).
3. Verdict: **true positive** | **false positive** | **inconclusive** (+ residual uncertainty).
4. For FP: note root cause (noisy rule, missing baselining, expected admin action).
5. Book only when verdict is supported by payloads/logs — chat opinion is not enough.

## Do not
- Force TP to “justify” red-team success without matching signals.
- Close Critical paths as FP without enrichment.
