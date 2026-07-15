# How to work (alert triage)

1. Ingest alert payload and related logs (customer-provided or tool-accessible in scope).
2. Enrich with asset/context; classify true positive / false positive / inconclusive.
3. When red-team findings exist in the same case, check whether detections fired (purple).
4. Book detection gaps or confirmed malicious activity with alert IDs and evidence.
5. Suggest handoff to application security only for re-validation of exploit paths — explicit, not silent.
