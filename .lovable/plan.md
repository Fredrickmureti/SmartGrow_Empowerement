
# Replenishment — Deferred Items 15 & 16

Scope is intentionally narrow: only the two items from the previous agent's handoff that don't require new domains. Items 10 (Manufacturing Orders) and 17 (Forecast tie-in) stay out — no new subsystems.

Not addressed here: broader audit of the replenishment engine (out of scope per your answer). If you want that in a follow-up, say the word.

---

## Item 16 — Retire the Auto-PO log tab

**Why:** The workspace mixes two audiences. Planners triage recommendations; the Auto-PO log is an operational audit of trigger-driven auto-POs. Keeping it as a third tab on a planning workspace confuses the mental model ("is this where I plan, or where I audit?") and pushes the recommendations engine into second place visually.

**What changes**

- Remove the `Auto-PO log` tab from `src/pages/ReplenishmentLog.tsx`.
- Drop `logSearch`, `logStatus`, `filteredLogs`, and the log rendering block (~lines 759–end of that TabsContent).
- Keep `useReplenishmentLogs` — it's still consumed by `Recommendations` and `Runs` context (verify) and by the archival route.
- Add a new archival route: `src/pages/inventory/AutoPoLog.tsx` — the extracted log UI, filters, and hook usage, unchanged.
- Register it in `src/apps/inventory/routes.tsx` at `/inventory/replenishment/auto-po-log`.
- Add a small `Auto-PO log` link in the workspace header (secondary button, next to `Run Planning`), so operators can still reach it.
- Update `src/apps/inventory/nav.ts` only if the log currently has a nav entry; otherwise, header link is enough.
- Rename `src/pages/ReplenishmentLog.tsx` file identity in comments (top-of-file JSDoc) to reflect it is the planning workspace, not a log page. Do not rename the file itself in this pass — the route path is stable and a rename fans out to the router.

**Verification**
- Tabs list shows only `Recommendations` and `Runs`.
- `/inventory/replenishment/auto-po-log` renders the previous log tab identically (same filters, same table, same empty state).
- Type check clean; existing `useReplenishmentLogs` tests untouched.

---

## Item 15 — Route recommendation approvals through `approval_rules`

**Why:** Today `handleApprove` in `RecommendationDrawer` writes `status = 'approved'` directly. That is a bespoke state machine that bypasses the platform's approval subsystem (`approval_rules`, `approval_rule_logs`, `useApprovalGate`, `AppAccessApprovalsInbox`). Every other entity that requires sign-off (sales orders, app access, etc.) goes through this engine; replenishment must too, so that:
- Org admins can configure "orders over N units / value require approval" without a code change.
- A single inbox surfaces pending approvals across modules.
- Audit trail is uniform (`approval_rule_logs` with requester, approver, timestamps, notes).
- SoD rules (requester ≠ approver) are enforced centrally.

**Data model**

No new tables. Use existing:
- `approval_rules` — entity_type = `'procurement_recommendation'`, action_name = `'approve'`, optional threshold on `suggested_qty` or `estimated_cost`.
- `approval_rule_logs` — one row per approval request; status `pending` / `approved` / `rejected`.

Seed one default inactive rule per business on first workspace load? No — leave rule creation to Settings > Approvals like every other entity. Document it in the empty-state hint.

**State machine change**

Current: `open → in_review → approved → (convert)` — all client-driven, no gate.

New:
```
open ──request review──► in_review ──[approval_rules match?]──►
                                     │ yes → pending approval → approved (by approver)
                                     │ no  → approved directly (no rule configured)
                         └──convert──► po_created / transfer_created / dismissed
```

`in_review` becomes the trigger point that consults `useApprovalGate.checkApproval('procurement_recommendation', 'approve', rec.id, { suggested_qty, estimated_cost })`.
- If `blocked` → create `approval_rule_logs` row via `requestApproval`, keep rec at `in_review`, show a `Pending approval` badge + the rule name.
- If not blocked → transition to `approved` immediately (preserves current behaviour when no rule is configured).

Approver actions live in the existing approvals inbox (`AppAccessApprovalsInbox` today only handles app-access; extend it or add a sibling `ProcurementApprovalsInbox` — decision below).

**Wiring**

1. **`src/hooks/useProcurementRecommendations.ts`**
   - Add a new mutation `requestApprovalOrApprove({ id, values })` that:
     - Calls `useApprovalGate.checkApproval`.
     - If blocked and no existing pending log → `requestApproval` (creates `approval_rule_logs` row), sets rec `status = 'in_review'`, stores `approval_log_id` on the rec.
     - If not blocked → sets `status = 'approved'` directly.
   - Retain `setStatus` for dismiss / snooze / manual overrides.

2. **Migration** — add `approval_log_id uuid` (nullable, FK to `approval_rule_logs`) on `procurement_recommendations` so the drawer can render the pending state and approvers can round-trip. GRANTs unchanged (table already grants authenticated). No RLS change — reads follow existing business scope.

3. **`RecommendationDrawer.tsx`**
   - Rename the primary CTA to `Approve` still, but its handler is `requestApprovalOrApprove`.
   - When `rec.status === 'in_review' && rec.approval_log_id`, replace the Approve/Reject buttons with a `Pending approval — <ruleName>` callout and a `Cancel request` link (deletes/rejects the log, returns rec to `open`).
   - Disable `Convert to PO` / `Convert to Transfer` while `status !== 'approved'` when a rule was matched (preserve solo-mode passthrough when no rule).

4. **Inbox surface** — extend `AppAccessApprovalsInbox` into a generic `ApprovalsInbox` that groups pending `approval_rule_logs` by `entity_type`. Add a small `Procurement recommendation` section with:
   - product · vendor · suggested qty · estimated cost · requester · age.
   - `Approve` / `Reject` buttons calling `useApprovalGate.approveRequest` / `rejectRequest`.
   - On approve, a lightweight postgres trigger promotes the linked rec to `approved`; on reject, it returns to `open` with `dismissed_reason` set from the note. (Trigger belongs in the same migration.)

5. **Trigger (migration)**
   ```sql
   -- when approval_rule_logs row for entity_type='procurement_recommendation'
   -- transitions to approved/rejected, mirror it onto the rec.
   ```
   Keeps the workspace live-updating via the realtime subscription that already listens on `procurement_recommendations`.

6. **Settings** — no UI change; org admins already manage approval rules from the existing Settings > Approvals page. Confirm `entity_type` dropdown includes `procurement_recommendation` (add to the enum/options list there — one-line change).

**Backwards compatibility**

- Businesses with zero rules configured see identical behaviour (approve → approved). No forced migration for existing recs.
- Existing `in_review` recs without an `approval_log_id` continue to render an Approve button (legacy path).

**Verification**
- With no rule: click Approve → status becomes `approved`, mutation returns fast, no `approval_rule_logs` row.
- With a rule (`suggested_qty > 50`): Approve on a qty-100 rec → status is `in_review`, `approval_log_id` populated, drawer shows Pending state, inbox lists it.
- Approver clicks Approve in inbox → rec flips to `approved` in real time (workspace subscription).
- Approver clicks Reject → rec flips to `open`, drawer shows the rejection note.
- SoD: requester ≠ approver enforced by inbox (hide Approve button on own request).
- Type check clean. Add one vitest around the mutation branch (`useProcurementRecommendations.approve.test.ts`).

---

## Sequencing

1. Migration (adds column + trigger + enum entry).  ← must land first.
2. Hook + drawer wiring.
3. Inbox extension.
4. Auto-PO log extraction + tab removal.
5. Manual verification + one vitest.

Estimate: single build turn should cover 1, 2, 4; item 3 (inbox) is the largest surface — may spill.
