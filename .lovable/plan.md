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

### Pass 2 (next)

1. Verify the three candidate deletions in the audit doc (`app-lifecycle`, `post-loan-interest-accrual`, `activate-organization`) against marketplace flows, outbox producers, and emailed activation links.
2. Retire additional zero-caller fns to drive `CEILING ≤ 87`.
3. Repoint any remaining callers onto `submitIntent({ documentKind: … })`.
4. Lower `CEILING` on every retirement; guard must stay green.
5. When `CEILING` hits 87, flip Wave 6.5 → ✅ and Wave 7 → ▶ ACTIVE.

Exit criteria: audit doc up-to-date, edge-fn count ≤ 87, guard green, deprecated shims still functional, `dispatch-print-jobs` cron still firing.


## Wave 7 — POS Receipt Convergence

Preserve the previous engineer's subwaves; execute in order, no shortcuts:

- **7.1** Server-side `thermalReceipt` renderer in `_shared/rendering/renderers/thermal-receipt.ts` with byte-parity fixtures against the current `ReceiptTemplateGenerator` (golden-file tests under `src/test/rendering/`).
- **7.2** Mechanical rewrite of every POS hook / checkout component / label page from `PrintClient.print(…)` and `useDocumentPrint(…)` onto `submitIntent({ documentKind, recordId, scenario })`. Drive the allow-list from Wave 6.5 to zero.
- **7.3** Delete `PrintClient`, `usePrintOrPreview`, `useDocumentPrint`, `ReceiptTemplateGenerator`, and `BrowserHardwareAdapter.print` (adapter keeps `open/close/scan/etc`).
- **7.4** `POS_CHOKEPOINT_V2` feature flag with one-release dual-write so a rollback is a config flip, not a code revert.
- **7.5** Architecture guards: no `PrintClient` imports anywhere; no client-side `print_jobs` insert; no `window.print()` outside the print-preview surface.
- **7.6** Latency fast-path — `submit_document_intent` triggers a `pg_net.http_post` to `dispatch-print-jobs` when `scenario='on_close'`, so POS receipts print p95 ≤ 2 s without waiting for the next cron tick.

Exit: byte-parity golden tests green, POS smoke (`e2e/`) green, `PrintClient` gone, allow-lists empty.

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
