# Physical Inventory Count — Audit & Enterprise Redesign

## Phase 1 — Audit findings (what is actually wrong)

**1. The RPC error is a deploy-hygiene bug, not a logic bug.**
The database has *duplicate overloaded* lifecycle functions. The previous agent added a wider signature but left the old thin wrapper deployed:

- `physical_count_approve(count_id, user_id, allow_self)` — thin wrapper that just calls the 4-arg version
- `physical_count_approve(count_id, user_id, allow_self, tolerance_override_reason DEFAULT null)` — real body

The frontend calls with `{p_count_id, p_user_id, p_allow_self}`. Because the 4-arg version's extra param has a DEFAULT, **both** signatures are valid candidates → PostgREST cannot resolve → the "could not choose the best candidate function" error. The identical duplication exists for `physical_count_submit` and `physical_count_post` (2-arg wrapper + 3-arg body).

**2. `p_allow_self` is vestigial.** The real approve/submit/post bodies never read `p_allow_self` — separation-of-duties is decided entirely by `governance_assert_not_self`, which reads `organizations.governance_mode`, `self_action_policy`, and `self_action_overrides`. So the previous "fix" that made the button clickable did nothing at the DB layer; governance was already correct. The client `p_allow_self` flag is dead weight that also *causes* the overload ambiguity.

**3. Governance is actually sound.** `governance_assert_not_self`: `solo` mode + ≤1 member → auto-allow (audited); `standard` → warn (allow) for owner/admin, block for others; `strict` → block unless a fresh override exists. The original "self-approval wrongly blocked" symptom only occurs when the org is `strict`/multi-member — which is correct enterprise behavior. No governance rewrite needed; it needs verification tests, not surgery.

**4. The Counts workspace already exists but is orphaned.** `PhysicalCountWorkspace` (`/inventory-app/physical-counts`) with Active / In-review / Posted / All buckets is built and routed — but it is **not in the sidebar nav** (`nav.ts` only links `/count`, the counting wizard). Users who post/submit get navigated to the *detail* page and have no sidebar path back to the list. This is the "trapped / dead-end / no workspace" complaint.

**5. The detail page is data-rich but not workflow-legible.** It has summary cards, a preflight banner, JE preview, audit stream, and context-aware buttons — but no workflow *stage indicator*, no approval *timeline*, no "what happens next / who does it" guidance, and recounts are invisible after the fact.

**6. Recount is destructive.** `physical_count_request_recount` sets the chosen lines to `recount_required`, **nulls `counted_qty`**, and reverts the whole count to `counting`. Prior counted values are lost (only a line-count is logged), so recount rounds are not traceable.

## Phase 2 — Business workflow model (target)

```text
draft ─freeze→ counting ─submit→ in_review ─approve→ approved ─post→ posted
                  ↑                    │
                  └──request_recount───┘
any active state ─cancel→ cancelled          posted ─supersede→ superseded (reversal)
```
Per state: permitted actions, the single *primary next action*, the responsible actor, and whether the page is editable or a read-only audit record. Every transition already emits a `physical_count_events` row — we build the UI on top of that event stream rather than inventing new state.

## Phase 3 — UX redesign (detail page, from first principles)

Rebuild `PhysicalCountDetail` around four zones:
1. **Workflow stepper** — horizontal Draft → Counting → In review → Approved → Posted, current stage highlighted, terminal states (cancelled/superseded) shown distinctly. Derived from `state` + events.
2. **Next-action card** — one prominent, state-aware CTA with a plain-English sentence: what just happened, what is next, who performs it, and why any action is blocked (fed by the existing `physical_count_preflight` checks). Replaces the scattered header buttons as the primary driver; header keeps secondary actions.
3. **At-a-glance summary** — warehouse, count type, tolerance, variance summary (surplus / shrinkage / net), line counts, and inventory impact.
4. **Tabs** — Lines, JE preview, **Recounts** (new), Activity timeline (existing audit, rendered as a readable vertical timeline instead of raw JSON), Drill-down. Posted/cancelled/superseded render read-only with an "audit record" banner.

## Phase 4 — Database / RPC redesign (one migration)

- **Drop the thin wrapper overloads** for `approve`, `submit`, `post` so exactly one signature per verb remains. Standardize each canonical signature to accept its params with DEFAULTs (`p_allow_self` retained only as an accepted-but-ignored arg for backward compatibility, or removed and the client stops sending it — the client will stop sending it). This permanently removes RPC ambiguity.
- **Make recount non-destructive.** Update `physical_count_request_recount` to copy the current `counted_qty` into `recount_qty` history (and into the event payload as `previous_qty` per line) before clearing it, and stamp a `recount_round` counter on the count/event. Prior rounds stay fully reconstructable from `physical_count_events`. Nothing is deleted.
- Keep all governance calls intact; add no new privileged surface.

## Phase 5 — Frontend architecture

- **Nav:** add a "Counts" entry (`/inventory-app/physical-counts`) to `nav.ts` Operations group so the workspace is always reachable; keep "New count" → `/count`.
- **Workspace:** stop sending `p_allow_self`; add a "Recount requested" bucket and clearer state filters; keep it the operational hub.
- **Detail/wizard:** stop sending `p_allow_self`; wire recount round history into the new Recounts tab; ensure cache invalidation covers workspace + detail + preflight (already mostly present); confirm deep-linking/refresh/back-button all resolve from `useParams` (already the case).

## Phase 6 — Implementation order

1. Migration: drop duplicate overloads, harden recount for traceability.
2. Remove `p_allow_self` from all client RPC calls (wizard, workspace, detail).
3. Add the nav entry.
4. Redesign `PhysicalCountDetail` (stepper, next-action card, timeline, Recounts tab, read-only terminal states).
5. Add the Recount-requested bucket to the workspace.
6. Verify: clicking Approve succeeds; solo-org self-approval works; strict-org self-approval blocks with a clear message; recount preserves prior rounds. Run the existing `architecture.physical-count-lifecycle` tests plus a browser pass through freeze → submit → approve → post and a recount cycle.

## Technical notes
- Overload fix is the single source of the reported error; verified via `pg_get_functiondef` that both signatures exist and the 4-arg default makes them ambiguous under PostgREST named-arg resolution.
- No change to the ledger/JE posting path, tolerance logic, or `governance_assert_not_self`.
- Recount history uses existing columns (`recount_qty`, `physical_count_events`) — no new tables required, so no new GRANTs/RLS.
