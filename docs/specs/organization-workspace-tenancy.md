# Spec: Organization × Workspace tenancy

**Status:** Implementable Spec (product contract) — **living**  
**Tracker (to-spec / `ready-for-agent`):** [#479](https://github.com/zangjiaao/my-ai-pen/issues/479)  
**Decision source:** Owner draft (2026-08-17) — local `docs/specs/organization-workspace-tenancy.md`  
**Product path:** Platform + Node4 (ADR 0001). Does not change Graph × Pi.  
**Related:** [`owner-ledger.md`](owner-ledger.md), [`owner-intel.md`](owner-intel.md), [`expert-offers.md`](expert-offers.md)

**Does not implement product code in this document** — ownership, visibility, and migration contracts only.

## 1. Problem

The current platform mixes three incompatible scopes:

1. user-owned Cases and ledger rows;
2. globally managed Nodes and Experts;
3. nullable `user_id` rows treated as shared data.

That shape is unsafe once one platform serves multiple companies, branches, red teams, users, and Nodes. It also makes concurrency fixes ambiguous: a lock or unique constraint cannot be correct until its tenant scope is known.

This Spec defines the target ownership and visibility model before implementation.

## 2. Locked decisions

### 2.1 Flat security hierarchy

The product has exactly two administrative/data levels:

1. **Organization** — the company/tenant boundary.
2. **Workspace** — one branch, red team, business unit, or other data/execution boundary inside an Organization.

Organizations do **not** recursively contain child Organizations. A branch is a Workspace, not a child tenant.

This is intentional:

- arbitrary trees make every authorization query recursive;
- real management reporting hierarchies change more often than security boundaries;
- one user may work across several branches or red-team engagements;
- a flat Workspace membership model is easier to audit and revoke.

If a customer later needs an organization chart, it is metadata/reporting over Workspaces, not an authorization parent chain.

### 2.2 User membership

- A User belongs to one Organization.
- A User may be a member of multiple Workspaces in that Organization.
- The UI has one explicit current Workspace.
- A Workspace id from the client is a selector, never proof of access. The server must verify membership.
- Organization administration and Workspace participation are separate permissions.

Fine-grained enterprise RBAC is not required by this Spec. The minimum boundary is:

- Organization administrators manage Organization members, Workspaces, Nodes, and Node assignments.
- Workspace members operate Cases and Workspace ledger data.
- Read-only roles may be added later without changing the ownership model.

### 2.3 Node and Expert

- A Node belongs to one Organization.
- A Node may be assigned to multiple Workspaces in that Organization.
- A Node may execute only Cases whose Workspace is assigned to that Node.
- An Expert remains bound to exactly one Node.
- Expert visibility follows the Node's Workspace assignments; there is no independent Expert-to-Workspace ownership tree.
- Node and Expert names are unique within an Organization, not globally.
- Each Workspace selects its own default Expert from the Experts visible through its assigned Nodes.
- A disabled Expert, an offline Node, or a Node no longer assigned to the Workspace is not eligible as that Workspace's default.

The current global `experts.is_default` behavior is retired by this target model. Default selection is a Workspace setting.

### 2.4 Case and ledger ownership

These resources have one immutable **home Workspace**:

- Case / Conversation
- Asset / Host, Service, Service path, Group, and Assembly
- Finding / Vulnerability
- Intel
- Evidence
- Report
- Schedule
- durable Case/product-state rows derived from them

Each row must carry an Organization and Workspace scope directly or inherit it through a non-ambiguous foreign-key parent. User id records the actor/creator; it is not the data-sharing boundary.

`user_id IS NULL` must never mean “shared with everyone.”

### 2.5 Explicit sharing

Asset, Finding, and Intel are private to their home Workspace by default. Cross-Workspace visibility requires an explicit grant.

Supported targets:

1. a named Workspace in the same Organization;
2. an explicit Organization publication target, when that resource type supports publication.

Supported permissions:

- **read** — target members can view and use the resource as prior context;
- **collaborate** — target members may update allowed shared fields without changing the home Workspace.

Sharing laws:

- The source row keeps one home Workspace; sharing does not clone or transfer ownership.
- A shared Asset does not automatically reveal its Findings or Intel.
- A shared Finding includes only the Evidence required to understand that Finding.
- Intel is shared independently and explicitly because it may contain credentials or operational secrets.
- Revoking a grant removes future access without deleting the source row.
- Cross-Organization sharing is out of scope.

The UI may offer a bundle action (“share Asset with selected Findings/Intel”), but the backend records explicit grants for each resource.

## 3. Ubiquitous language

### Organization

One company-level tenant. Owns users, Workspaces, Nodes, Expert instances through Nodes, billing, and organization policy.

_Avoid_: using Organization as a recursive branch tree; treating it as an asset Group.

### Workspace

One flat data and execution boundary inside an Organization. Examples: Shanghai branch, overseas subsidiary, internal red team, or a regulated business unit.

_Avoid_: project folder; asset tab; arbitrary child Organization.

### Workspace Membership

The explicit relation granting one User access to one Workspace.

_Avoid_: trusting a client-supplied workspace id; deriving membership from having created a row there.

### Node Assignment

The explicit relation allowing one Organization-owned Node to execute Cases for one Workspace. One Node may have several assignments.

_Avoid_: making a live WebSocket connection equivalent to Workspace authorization.

### Home Workspace

The single Workspace that owns a resource throughout its lifetime.

_Avoid_: changing owner when sharing; using the latest accessing User or Case as owner.

### Explicit Share

A revocable grant from a home Workspace resource to another Workspace or to the Organization publication scope.

_Avoid_: `NULL` owner, implicit same-Organization visibility, or copying rows to simulate sharing.

### Group

The existing Owner Ledger assembly bucket (company/system/project view). It is not an authorization or tenancy boundary.

_Avoid_: using Group as Workspace; deriving permissions from Group membership.

## 4. Target relationships

```text
Organization
├── Users
├── Workspaces
├── Nodes
│   └── Experts
├── Workspace Memberships  (User ↔ Workspace)
└── Node Assignments       (Node ↔ Workspace)

Workspace
├── Cases
├── Owner Ledger
│   ├── Groups
│   ├── Hosts
│   ├── Services / paths
│   ├── Findings / Evidence
│   └── Intel
├── Reports / Schedules
└── Default Expert setting
```

## 5. Authorization context

Every authenticated operation resolves a structured context:

```text
TenantContext
  actor_user_id
  organization_id
  workspace_id
  organization_role
  workspace_membership
```

Rules:

1. JWT identifies the User, not an arbitrary Organization or Workspace.
2. HTTP selects a Workspace through a route/header/session field, then verifies Membership.
3. User WebSocket messages carrying `conversation_id` resolve the Case and verify Workspace Membership before subscribe, persist, dispatch, steer, interrupt, or decision handling.
4. Node authentication resolves a Node principal.
5. Node ledger and Node WebSocket writes resolve the Case Workspace from the database and verify an active Node Assignment.
6. Services receive `TenantContext` or a trusted scope derived from it; they do not accept optional owner ids that turn missing scope into an unfiltered query.
7. Authorization failures are fail-closed and return no existence detail across inaccessible scopes.

## 6. Target persistence model

Names are illustrative; migrations may match repository conventions.

### 6.1 Core tenancy

- `organizations`
- `workspaces(organization_id, name, ...)`
- `workspace_memberships(workspace_id, user_id, role, ...)`
- `node_workspace_assignments(node_id, workspace_id, ...)`
- `workspace_default_experts(workspace_id UNIQUE, expert_id, ...)`

Required constraints:

- a Workspace belongs to exactly one Organization;
- a Membership User and Workspace must belong to the same Organization;
- a Node Assignment Node and Workspace must belong to the same Organization;
- a Workspace default Expert's Node must be assigned to that Workspace;
- Workspace name is unique within its Organization;
- Node name is unique within its Organization;
- Expert mention name is unique within its Organization.

### 6.2 Business scope

Add `organization_id` and `workspace_id` where direct scope is required. Child rows may inherit through a mandatory parent only when authorization queries cannot become ambiguous.

At minimum, direct Workspace scope is required on high-volume/top-level query roots:

- conversations;
- assets;
- vulnerabilities;
- asset_intel;
- evidence;
- reports;
- schedules;
- Owner Ledger groups.

All business unique constraints and indexes must include the correct scope. Examples:

- default Expert: one row per Workspace;
- Finding identity: Workspace + Case/Asset identity fields;
- Intel identity: Workspace + Asset/Service identity fields;
- inventory/surface identities: Workspace + existing domain key.

### 6.3 Sharing

Use resource-specific grant tables with real foreign keys:

- `asset_workspace_grants`
- `finding_workspace_grants`
- `intel_workspace_grants`

Each grant records source resource, target Workspace, permission, actor, and timestamps. Organization publication is an explicit visibility field or a separate grant target; it must not be inferred from missing scope.

Do not use a polymorphic `(resource_type, resource_id)` table unless referential integrity can be enforced.

## 7. Default Expert concurrency

Default Expert selection is serialized within one Workspace:

1. verify the actor can manage that Workspace;
2. verify Expert eligibility and Node Assignment;
3. lock the Workspace default row (or Workspace row) in a transaction;
4. update/insert the Workspace's selected Expert;
5. rely on `UNIQUE(workspace_id)` as the final invariant;
6. map an unexpected unique conflict to `409 Conflict`.

Two Workspaces may change defaults concurrently without blocking each other.

The global partial unique index on `experts.is_default` must not ship as the final multi-user model.

## 8. Migration strategy

### Phase A — security gates before schema expansion

1. Reject WebSocket connections when neither JWT nor Node token is valid.
2. Add Case ownership/Membership checks to every User WebSocket action.
3. Require Case scope on Node ledger calls and verify Node-to-Case authorization.
4. Stop returning persisted Node tokens from list/detail APIs.

These fixes are required even while the current single-Workspace compatibility mode remains.

### Phase B — deterministic backfill

1. Create one default Organization and one default Workspace for the existing installation.
2. Attach all existing Users to the Organization and grant Membership in the default Workspace.
3. Attach all existing Nodes to the Organization and assign them to the default Workspace.
4. Backfill all existing business rows into the default Workspace.
5. Detect and report ambiguous/orphan rows; do not silently assign rows that contradict an existing owner relationship.
6. After validation, make required Organization/Workspace columns non-null.

### Phase C — scope-aware APIs

1. Introduce the server-side TenantContext resolver.
2. Scope HTTP list/get/update/delete and dashboard projections.
3. Scope User and Node WebSocket paths.
4. Scope Node/Expert catalogs and default selection.
5. Remove nullable-owner compatibility reads.

### Phase D — sharing and UI

1. Add Workspace switcher and current Workspace routing.
2. Add Workspace membership and Node assignment management.
3. Add resource source/share indicators and explicit grant/revoke dialogs.
4. Add per-Workspace default Expert selection.
5. Add audit events for Membership, Node Assignment, default changes, publication, share, and revoke.

### Phase E — concurrency and multi-instance hardening

1. Centralize Conversation context mutation behind row locking or versioned CAS.
2. Add scope-aware Finding/Asset upserts and business unique constraints.
3. Persist task-terminal idempotency by `(conversation_id, task_id)`.
4. Make counters atomic or derive them from durable active rows.
5. Before multiple Platform workers/replicas, externalize connection routing, subscriptions, pending approvals, and demand queues.

## 9. UI laws

- The current Workspace is always visible in global navigation.
- Switching Workspace clears Case selection and Workspace-scoped client caches.
- A User sees only Nodes assigned to the current Workspace, except Organization administrators in the Organization management view.
- Expert selectors show Experts inherited from assigned Nodes.
- Shared resources show home Workspace, permission, and source; they never look locally owned.
- Sharing Intel requires an explicit warning because Intel may contain credentials.
- Asset `Group` tabs remain ledger organization inside one Workspace; they do not switch tenancy.

## 10. Out of scope

- recursive Organizations or arbitrary Organization trees;
- cross-Organization sharing;
- custom enterprise role builders;
- Node-to-Node direct mesh;
- automatic sharing based on company email domain, Group membership, Node use, or Case participation;
- changing a resource's home Workspace as a side effect of share;
- treating Organization publication as the default visibility.

## 11. Acceptance criteria

1. Two Organizations cannot discover or access each other's IDs, Nodes, Experts, Cases, ledger rows, shares, or WebSocket events.
2. Two Workspaces in one Organization are isolated by default.
3. A multi-Workspace User sees data only for the explicitly selected Workspace.
4. A Node can execute Cases for every assigned Workspace and no unassigned Workspace.
5. Experts automatically follow their Node's assignments.
6. Each Workspace can select a different default Expert; concurrent changes preserve exactly one setting per Workspace.
7. Sharing one Asset does not reveal its Findings or Intel unless separately granted.
8. Sharing one Finding exposes only its required Evidence.
9. Revoking a grant removes target access without deleting or moving the source.
10. No user-private business query becomes unfiltered when Organization, Workspace, User, or Conversation scope is missing.
11. Historical data migration reports ambiguous rows and leaves no nullable-scope bypass.
12. Single-worker deployment remains mandatory until real-time state is externalized.

## 12. Suggested implementation slices

1. **Auth hotfix:** WebSocket fail-closed + Case membership + Node ledger binding.
2. **Tenancy schema:** Organization, Workspace, Membership, Node Assignment, deterministic backfill.
3. **Catalog scope:** Node/Expert Organization scope + Workspace default Expert.
4. **Case scope:** Conversation, message, report, schedule, evidence.
5. **Ledger scope:** Asset, Finding, Intel, Owner Ledger children and indexes.
6. **Sharing:** resource grants, audit, API, UI.
7. **Concurrency:** context CAS/lock, upserts, task idempotency, atomic counters.
8. **Scale-out:** shared WebSocket routing and durable pending/queue state.

## 13. Seams (test high)

Prefer **one primary pure seam**. Existing auth/list/upsert tests stay adapters.

| Seam | Behavior |
|---|---|
| **S1 TenantContext resolver (primary)** | `(jwt, selected_workspace_id) → TenantContext` or fail-closed. JWT identifies the User only. A client Workspace id is a selector, never proof. Missing Organization/Workspace/Membership yields no unfiltered query and no cross-scope existence detail. |
| **S2 Resource visibility** | `(TenantContext, resource) → deny \| home \| read \| collaborate`. Home Workspace is immutable. Asset grant does not reveal Findings or Intel. Finding grant includes only required Evidence. Intel grant is independent. Revoke drops future access without deleting or moving the source. |
| **S3 Workspace default Expert** | Exactly one default per Workspace. Eligible only if the Expert's Node is assigned to that Workspace and is schedulable. Concurrent updates serialize inside one Workspace; two Workspaces do not block each other. Global `experts.is_default` is not the multi-tenant model. |
| **S4 Deterministic backfill** | Existing install → one default Organization + one default Workspace; Users, Nodes, and business rows attach there. Ambiguous/orphan rows are reported, not silently assigned. After validation, scope columns are non-null. |

Primary unit seam: **S1**. Highest integration: two Organizations cannot see each other; two Workspaces in one Organization are isolated until an explicit grant.

## 14. User Stories

1. As an operator in company A, I want no visibility of company B's IDs, Nodes, Experts, Cases, or ledger rows, so that tenants cannot discover each other.
2. As a user who belongs to two Workspaces, I want only the currently selected Workspace's data, so that the other team's Cases and ledger do not bleed in.
3. As an Organization administrator, I want to assign one Node to several Workspaces, so that one worker can execute for more than one team.
4. As a Workspace member, I want Experts to follow their Node's assignments, so that I do not maintain a second Expert-to-Workspace tree.
5. As a Workspace administrator, I want this Workspace's own default Expert, so that new-chat default is per team, not a global `is_default`.
6. As two Workspace administrators, I want concurrent default changes not to collide across Workspaces, so that each Workspace keeps exactly one default.
7. As an operator, I want sharing an Asset not to reveal its Findings or Intel, so that secrets stay explicit.
8. As an operator, I want sharing a Finding to include only the Evidence required to understand it, so that I can hand off a finding without dumping the Case.
9. As an operator, I want Intel sharing to be a separate grant with a warning, so that credentials are not leaked by an Asset share.
10. As an operator, I want revoke to drop the target's access without deleting or moving the source, so that the home Workspace keeps the row.
11. As an implementer, I want a missing Organization, Workspace, User, or Case scope to fail closed, so that a forgotten filter never becomes a global list.
12. As an operator after upgrade, I want existing data in one default Organization and Workspace, so that a single-tenant install keeps working.
13. As an operator, I want ambiguous historical rows reported rather than silently re-owned, so that migration does not invent a tenant.
14. As an operator, I want the current Workspace always visible in navigation, so that I know which tenancy I am in.
15. As an operator, I want switching Workspace to clear Case selection and Workspace-scoped caches, so that Workspace A does not leak into B.
16. As an Organization administrator, I want the Organization management view to show all Organization Nodes, so that I can assign them to Workspaces.
17. As an operator, I want shared resources to show home Workspace, permission, and source, so that they never look locally owned.
18. As a Node, I want to execute only Cases whose Workspace is assigned to me, so that a live socket is not authorization.
19. As a user, I want WebSocket subscribe and steer to check Case Workspace membership, so that knowing a `conversation_id` is not access.
20. As an implementer, I want Node and Expert names unique within an Organization, so that two companies may both name a Node `prod`.
21. As an operator, I want Owner Ledger Group tabs to stay assembly inside one Workspace, so that Group is not confused with tenancy.
