# Document / Printing / Hardware — Resumption Plan

## Verification of previous engineer's claims

Confirmed against the live project (not just against `.lovable/plan.md`):

| Claim | Evidence | Verdict |
|---|---|---|
| Wave 1 tables exist (`document_kinds`, `document_records`, `document_artifacts`) | `information_schema` query | ✅ real |
| Wave 2 template registry (`document_templates`, `document_template_ast`, `document_theme`, `document_header_footer`, `format_registry`) | same | ✅ real |
| Wave 3 rendering engine | `supabase/functions/render-document` + `_shared/rendering/*` present | ✅ real |
| Wave 4 output resolver (`output_intents`, `output_dispatch_log`, `resolve-output-intent` fn) | tables + fn folder present | ✅ real |
| Wave 5 submit-intent chokepoint (`submit-document-intent`, `src/services/documents/submitIntent.ts`) | fn folder present | ✅ real |
| Wave 6 hardware roles + dispatcher (`printer_roles`, `printer_role_branch_bindings`, `print_jobs`, `dispatch-print-jobs`, pg_cron) | tables present, cron row `dispatch-print-jobs-every-minute` **active = true, schedule `* * * * *`** | ✅ real *and cron is firing* — the plan's "deploy-blocked" caveat is stale |
| Wave 6.5 marked ACTIVE | no `docs/audit/2026-wave6.5-legacy-inventory.md`, no `@deprecated` JSDoc on `PrintClient`/`usePrintOrPreview`/`useDocumentPrint`, no new ESLint restrictions on those imports, edge-fn count still **100** vs ceiling 87 | ❌ **not started** |
| Waves 7 / 8 / 9 | pending, code untouched | ⏸ as documented |

Net: Waves 1–6 are genuinely landed and Wave 6 is *not* deploy-blocked (cron is live). Wave 6.5 exists only as a section header. Resume execution from the top of Wave 6.5.

Correction to plan: strike the "deploy-blocked / SUPABASE_MAX_FUNCTIONS_REACHED" caveat on Wave 6 — the dispatcher is already scheduled and active. Wave 6.5 no longer needs to unblock deploys, but is still required to keep the edge-fn inventory guard honest and to prepare Wave 7's deletions.

## Wave 6.5 — Legacy Consolidation (IN PROGRESS — pass 1 landed 2026-07-27)

Goal: bring edge-fn count from 100 → ≤ 87, mark client-side legacy shims `@deprecated`, and land the inventory audit.

### Pass 1 (2026-07-27) — landed

- ✅ Audit doc: `docs/audit/2026-wave6.5-legacy-inventory.md` (caller-graph + candidate list + cron-safe list).
- ✅ Deleted 4 zero-caller functions: `override-return-diagnostic`, `send-leave-email`, `generate-cycle-counts`, `generate-audit-certificate`. Count 100 → **96**.
- ✅ Removed the now-orphaned `useOverrideReturnDiagnostic` hook.
- ✅ `@deprecated` JSDoc on `src/services/printing/PrintClient.ts` and `src/hooks/usePrintOrPreview.ts`. (`useDocumentPrint` and `ReceiptTemplateGenerator` do not exist as files — stale plan entries.)
- ✅ ESLint `no-restricted-imports` blocks new imports of the two shims; existing importers grandfathered via a ratchet allowlist in `eslint.config.js` that must shrink in Wave 7.
- ✅ `edge-fn-inventory.test.ts::CEILING` ratcheted 87 → 96 with a documented monotonic-decrease invariant.

### Pass 2 (2026-07-27) — BLOCKED on publish

Re-verified `app-lifecycle`, `post-loan-interest-accrual`, and `activate-organization`: zero code invokers, zero `cron.job` references. `supabase--delete_edge_functions` refused with: "codebase is mid-migration to TanStack Start, the migrated app has not been published yet; leave deployed functions live as rollback coverage; publish and verify first."

**Unblock sequence**

1. Publish the current TanStack build; smoke-test cron, print pipeline, and auth flows.
2. Confirm with ops that no emailed activation link still targets `activate-organization`.
3. Delete the three candidates → count 96 → 93; ratchet `CEILING`.
4. Continue retiring zero-caller fns toward `CEILING ≤ 87`, then flip Wave 6.5 → ✅ and Wave 7 → ▶ ACTIVE.


Exit criteria: audit doc up-to-date, edge-fn count ≤ 87, guard green, deprecated shims still functional, `dispatch-print-jobs` cron still firing.


## Wave 7 — POS Receipt Convergence (IN PROGRESS — 7.1 landed 2026-07-27; 7.2 blocked on 7.1.5)

Preserve the previous engineer's subwaves; execute in order, no shortcuts:

- **7.1** ✅ Byte-parity golden at the AST→ESC/POS seam. `ReceiptTemplateGenerator` never existed in this codebase (stale plan entry), so instead of a new `thermal-receipt.ts` file we lock the existing `renderAstToEscPos` output for a canonical POS receipt fixture. Test: `supabase/functions/_shared/rendering/renderers/thermal_receipt_golden_test.ts`; golden: `thermal_receipt_golden.json` (sha256 `495b7d7d…2153e`, 667 bytes @ 80mm). Auto-seeds on first run; any drift fails loudly with a 40-line preview. This is the parity gate Wave 7.2 must clear.
- **7.1.5** ⏸ **NEW — unlanded prerequisite discovered 2026-07-27.** `submit-document-intent` requires a pre-existing `document_records` row (`p_document_record_id` is not-null; edge fn 404s on missing lookup). `public.document_records` is currently empty (0 rows) and no `materialize_document_record(kind_code, source_module, source_doc_id)` RPC exists — grep for `materialize|create_document_record|upsert_document_record` returned zero hits in `supabase/functions` and `src/services`. Wave 7.2's mechanical rewrite therefore cannot proceed until we land:
  1. A SECURITY DEFINER RPC `public.ensure_document_record(kind_code text, source_module text, source_doc_type text, source_doc_id uuid, org_id uuid, business_id uuid, branch_id uuid, party_kind text, party_id uuid, currency text, snapshot jsonb) RETURNS uuid` that upserts on `(source_module, source_doc_type, source_doc_id)` and returns the record id. GRANTs to `authenticated` scoped by `_assert_org_member`.
  2. A client shim `src/services/documents/ensureDocumentRecord.ts` that wraps the RPC.
  3. Per-kind snapshot builders (starting with `pos.receipt_customer`, `pos.kitchen_ticket`, `sales.invoice`, `purchases.bill`) — a `src/services/documents/snapshots/<kind>.ts` file per module, each returning the JSON blob the renderer expects (compatible with the golden fixture).
  4. Unit tests that each snapshot builder produces byte-identical output to `printClient.print*` for the same source entity (leverages 7.1 golden methodology).
- **7.2** Mechanical rewrite of every `PrintClient.print(…)` / `usePrintOrPreview` caller (~35 files — full list in `docs/audit/2026-wave6.5-legacy-inventory.md`) onto:
  ```ts
  const recordId = await ensureDocumentRecord({...});
  await submitDocumentIntent({ documentRecordId: recordId, scenario: 'on_close' });
  ```
  Drive the allow-list in `eslint.config.js` from 35 to zero, module by module: POS terminal first (protected by 7.1 golden), then sales pages, then purchases/HR/hardware.
- **7.3** Delete `PrintClient`, `usePrintOrPreview`, and `BrowserHardwareAdapter.print` (adapter keeps `open/close/scan/etc`). `useDocumentPrint` and `ReceiptTemplateGenerator` do not exist — skip.
- **7.4** `POS_CHOKEPOINT_V2` feature flag with one-release dual-write so a rollback is a config flip, not a code revert.
- **7.5** Architecture guards: no `PrintClient` imports anywhere; no client-side `print_jobs` insert; no `window.print()` outside the print-preview surface.
- **7.6** Latency fast-path — `submit_document_intent` triggers a `pg_net.http_post` to `dispatch-print-jobs` when `scenario='on_close'`, so POS receipts print p95 ≤ 2 s without waiting for the next cron tick.

Exit: byte-parity golden green, POS smoke (`e2e/`) green, `PrintClient` gone, allow-lists empty.

## Wave 8 — Hardware Adapter Internals

- Fold `BrowserHardwareAdapter` / Electron `CommandRouter` / `LocalAgent` behind a single `TransportRouter` (partially done — see `docs/audit/2026-05-21-hardware-readiness-closeout.md`).
- Drain remaining `window.pos.*` reads inside `HardwareClient.ts` — enforced by the `host-router-single-source.test.ts` allow-list, drive that list to zero.
- Add capability negotiation so future hardware classes (scales, biometric, RFID) plug in via `hardware_capabilities` without new adapter code paths.

## Wave 9 — Legacy Table & Function Deletion

- Drop `receipt_settings` (data migrated into `document_theme` / `document_header_footer` during Wave 2).
- Retire the v1 `document_templates` shim (any remaining reads repointed at `document_templates` + `document_template_ast`).
- Delete edge fns whose only callers were Wave 7 deletions (second inventory pass; ceiling drops again).
- Drop deprecated RPCs / triggers with zero remaining call sites.
- Remove `@deprecated` sentinels — everything the code touches is canonical.

Exit: `edge-fn-inventory.test.ts` reflects the smaller surface, `.lovable/plan.md` archived, `docs/architecture/` gains a single "Document → Print → Hardware pipeline" overview replacing the wave-by-wave audits.

## Cross-wave invariants (do not violate)

- Every new `public` table: `GRANT` + `ENABLE RLS` + policies in the *same* migration.
- Only `submit-document-intent` inserts into `print_jobs`; only `dispatch-print-jobs` calls `claim_print_jobs`. Guards already in `wave6-dispatcher.test.ts`.
- No new edge fn may be a thin wrapper around another edge fn (guarded).
- Hardware ops only through `hardwareClient`; no direct `window.pos.*` outside the HostRouter allow-list.
- Update `.lovable/plan.md` at the end of every wave — the top-of-file status table is the single source of truth.

## Technical notes for implementers

- Live DB confirmations already ran: all Wave 1–6 tables exist; pg_cron rows `dispatch-print-jobs-every-minute` and `check-print-queue-slo-nightly` are active.
- Edge-fn count as of this plan: `ls supabase/functions | wc -l` → 100. Guard ceiling in `edge-fn-inventory.test.ts` → 87.
- Deletion of edge fns must go through the `supabase--delete_edge_functions` tool (removing the folder alone leaves the deployed function live and the guard still failing).
- When repointing legacy `generate-*` callers onto `submitIntent`, confirm each source has a matching `document_kinds` row and a `default_template_id`; add migrations for any gaps before deleting the fn.
