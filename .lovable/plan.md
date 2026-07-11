
# Edge Function Consolidation Analysis

**Current state:** 103 deployed functions (102 + `_shared`). Ceiling test in `src/test/architecture/edge-fn-inventory.test.ts` is set at **87**. We are **16 over**. ADR 0005 (fat edge functions) is the sanctioned pattern for merges.

**Off-limits (email delivery — will not touch):**
`send-email`, `send-admin-email`, `send-contact-message`, `send-document-email`, `send-invitation-email`, `send-leave-email`, `send-notification-email`, `send-platform-email`, `send-stock-alert-email`, `send-tenant-ownership-transfer`, `ai-generate-email`, `notify-po-confirmed`, `notify-tasks-due-soon`, `was-email-reaped`, `check-email-availability`.

---

## Consolidation candidates (ranked by risk, lowest first)

### 1. Payroll GL posting family → `payroll-gl` (7 → 1, saves 6)
Merge on `action` dispatch. All share the same JE-builder shape and post to `journal_entries`.
- `post-payroll-gl`
- `post-payroll-payment-gl`
- `reverse-payroll`
- `reverse-payroll-payment`
- `post-garnishment-payment`
- `post-remittance-payment`
- (keep loan trio separate — see §2)

Body: `{ action: "post"|"reverse", scope: "payroll"|"payment"|"garnishment"|"remittance", ... }`. Handlers move to `_shared/payroll-gl/`. Auth: admin JWT on all branches. Existing callers get thin client wrappers.

### 2. Loan lifecycle → `loan-gl` (3 → 1, saves 2)
- `post-loan-disbursement`
- `post-loan-interest-accrual`
- `post-loan-settlement`

Dispatch on `action: "disburse"|"accrue"|"settle"`. Same domain, same JE shape.

### 3. Statutory return lifecycle → `statutory-return` (4 → 1, saves 3)
- `generate-statutory-return`
- `submit-statutory-return`
- `record-return-filing`
- `override-return-diagnostic`

Dispatch on `action`. Already a cohesive lifecycle around one aggregate (`return_filing`).

### 4. Localization pack management → `localization-pack` (7 → 1, saves 6)
- `install-localization-pack`
- `apply-localization-pack-upgrade`
- `rollback-localization-pack-upgrade`
- `promote-pack-version`
- `propose-localization-upgrades`
- `publish-localization-pack-version`
- `lint-localization-pack`

Keep `validate-localization-payload` separate (called from client-side pack editor with different auth), and keep `process-localization-outbox` separate (cron entry-point).

Dispatch on `action: "install"|"upgrade"|"rollback"|"promote"|"propose"|"publish"|"lint"`.

### 5. Default-mapping pair → merge into `localization-pack` above (2 → 0, saves 2)
- `apply-default-mappings` → `action: "apply_mappings"`
- `preview-default-mappings` → `action: "preview_mappings"`

Same domain and same input shape.

### 6. M-Pesa router → `mpesa` (3 → 1, saves 2)
- `mpesa-c2b`
- `mpesa-callback`
- `mpesa-outbound`

Path-segment dispatch (`/c2b`, `/callback`, `/outbound`). Callback URLs stored with Safaricom stay stable via path suffix. Already flagged as merge target in ADR 0005.

### 7. Payment provider orders → `payment-orders` (2 → 1, saves 1)
- `paypal-orders`
- `pesapal`

Dispatch on `provider` + `action`. Stripe stays separate because it has its own webhook signature verification and secret rotation surface.

### 8. Invitation lifecycle → `invitation` (3 → 1, saves 2)
- `accept-invitation`
- `validate-invitation`
- `invite-platform-admin`

Same domain, same tokens table. Split branches on `action`.

### 9. Org/data admin → `org-admin` (3 → 1, saves 2)
- `activate-organization`
- `clear-org-data`
- `clear-pos-data`

All are admin-authenticated one-shot ops on the same tenant scope.

### 10. Scheduled digests & checks — DO NOT merge yet
`check-*`, `nightly-integrity-check`, `process-scheduled-*`, `attendance-missed-checkout`, `check-leave-expiry`, `check-missing-timesheets`, `update-overdue-invoices`, `run-depreciation`, `generate-recurring-tasks`, `generate-cycle-counts`, `talent-cycle-tick`, `project-digest-dispatch`, `process-recurring-invoices`, `process-return-filing-overdue-digest`.

Each has its own pg_cron entry pointing at its own URL. Merging forces a coordinated pg_cron rewrite in tenant DBs and loses per-job log isolation. Defer until we cross the ceiling again.

---

## Net effect

| Merge | Removed | Kept |
|---|---:|---|
| 1. payroll-gl | 6 | 1 |
| 2. loan-gl | 2 | 1 |
| 3. statutory-return | 3 | 1 |
| 4. localization-pack | 6 | 1 |
| 5. default-mappings (into #4) | 2 | 0 |
| 6. mpesa | 2 | 1 |
| 7. payment-orders | 1 | 1 |
| 8. invitation | 2 | 1 |
| 9. org-admin | 2 | 1 |
| **Total** | **26** | |

**103 → 77 functions**, comfortably under the 87 ceiling and giving headroom for the fiscal/compliance work in flight.

## Rules every merge must follow (from ADR 0005)

1. One `Deno.serve`, `index.ts` under 400 lines, real logic in `_shared/<family>/*.ts`.
2. Explicit up-front dispatch on `body.action` — no string sniffing.
3. Auth gate per branch (admin JWT vs. service-role vs. public webhook).
4. File header lists every mode.
5. Handlers stay in `_shared/` so we can split later without a rewrite.
6. Each merge ships with:
   - A thin client wrapper preserving the old `functions.invoke("old-name", ...)` signature (delete after callers migrate in the same PR where possible).
   - Update to `src/test/architecture/edge-fn-inventory.test.ts` CEILING.
   - The old function directories deleted via `supabase--delete_edge_functions` **only after** the merged function is deployed and callers are repointed.

## Sequencing (safest → riskiest)

1. Loan-GL (§2) — small, self-contained, few callers.
2. Statutory-return (§3) — single feature area.
3. Payroll-GL (§1) — many callers but uniform shape.
4. Localization-pack + default-mappings (§4+§5) — biggest single win; touch publisher UI callers.
5. Invitation (§8), Org-admin (§9) — auth-sensitive, do last inside their own PRs.
6. M-Pesa (§6) — needs Safaricom URL update coordination; do only if we need more headroom.
7. Payment-orders (§7) — optional; smallest win.

## Out of scope

- All email/notification delivery functions.
- Stripe webhook (signature verification surface).
- Per-cron scheduled jobs (see §10).
- Bespoke integrations with external state or non-trivial cold-path cost: `terminal-outbound`, `biometric-ingest`, `etims-transmit`, `sms-webhook`, `sync-bank-transactions`, `ingest-bank-disbursement-ack`, `render-report`, `generate-document`, `compute-payroll`, `fiscal-compliance-saga`, `ai-assistant`, `provider-run`, `provider-test` (already fat).

---

Say **"proceed with §1"** (or list the merges you want) and I'll implement them one PR at a time, following the ADR 0005 rules and updating the inventory guard as we go.
