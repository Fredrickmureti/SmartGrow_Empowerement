# SMS Architecture

## Overview

The SMS feature is a tenant-scoped, ERP-grade communication capability. Tenants
configure their own Twilio credentials once, then SMS surfaces naturally
across Sales, Finance, Inventory, HR, and Contacts wherever it's relevant.
Automated event SMS is fully recipient-configurable; nothing is hardcoded.

## Layers

```
┌────────────────────────────────────────────────────────────────────┐
│ UI surfaces                                                        │
│  • PrintPreviewDialog → DocumentCommunicationBar (Email + SMS)     │
│  • InvoiceDetailDialog / SalesOrderDetailDialog / … (SendSmsButton)│
│  • SMS app: Settings, Templates, Event Rules, Recipient Groups,    │
│            Opt-Outs, Log                                           │
└────────────────────────────────────────────────────────────────────┘
                ↓ uses
┌────────────────────────────────────────────────────────────────────┐
│ State-aware availability hook                                      │
│  useSmsAvailability({ recipientPhone })                            │
│  → { canSend, configured, mode, userCanSend, recipientPhone,       │
│      recipientOptedOut, reason, reasonMessage }                    │
└────────────────────────────────────────────────────────────────────┘
                ↓ calls
┌────────────────────────────────────────────────────────────────────┐
│ Edge functions                                                     │
│  • send-sms              — manual & flushed sends, opt-out check,  │
│                            template rendering, sms_log writes      │
│  • check-inventory-alerts — enqueues low-stock events              │
│  • process-scheduled-automations — flushes sms_event_outbox        │
│  • sms-webhook           — Twilio status callback                  │
│  • test-sms-connection   — credential validation                   │
└────────────────────────────────────────────────────────────────────┘
                ↓ reads/writes
┌────────────────────────────────────────────────────────────────────┐
│ Database (Postgres)                                                │
│  Tables                                                            │
│    sms_provider_configs        — tenant-owned credentials (RLS)    │
│    sms_provider_configs_masked — read-safe view for UI             │
│    sms_event_rules             — per-event enable + recipient_type │
│    sms_event_rule_recipients   — extra recipients per rule         │
│    sms_recipient_groups        — reusable named lists              │
│    sms_recipient_group_members — user / role / phone members       │
│    sms_templates               — body + vars, per event            │
│    sms_event_outbox            — durable queue                     │
│    sms_log                     — every send (entity, template,     │
│                                  triggered_by, is_test, status)    │
│    sms_opt_outs                — per-org opt-out list              │
│    sms_webhook_health          — last delivery callback per send   │
│  Functions                                                         │
│    sms_build_doc_vars()        — common template vars              │
│    sms_enqueue_event()         — gated insert into outbox          │
│    sms_event_rule_enabled()    — gate                              │
│    resolve_rule_recipients()   — fan-out + opt-out + dedup         │
│    sms_scan_overdue_invoices() — daily cron                        │
│  Triggers (auto enqueue on business events)                        │
│    trg_sms_invoice_posted      — invoice → invoice_posted          │
│    trg_sms_payment_received    — payment → payment_received        │
│    trg_sms_sales_order_confirmed                                   │
│    trg_sms_estimate_sent                                           │
│    trg_sms_credit_note_issued                                      │
│    trg_sms_delivery_shipped                                        │
│    tg_sms_customer_statement_sent                                  │
│    tg_sms_payslip_paid                                             │
│    tg_sms_expense_state_change — approved / rejected               │
└────────────────────────────────────────────────────────────────────┘
```

## Recipient resolution flow

When the outbox processor flushes an event row, it calls
`resolve_rule_recipients(org_id, event, entity_type, entity_id, contact_id, phone)`
which returns one row per phone to send to. The function:

1. Picks the **primary recipient** based on the rule's `recipient_type`
   (`customer`, `vendor`, `employee`, `internal`):
   - explicit `phone` override wins
   - otherwise pulls from the linked `contacts` / `employees` row, gated by
     `sms_consent`
   - `internal` defaults to all active `owner`/`admin` users with a phone
2. Adds **rule-level extra recipients** from `sms_event_rule_recipients`:
   - `phone` — direct E.164
   - `user` — a specific user's profile phone
   - `role` — fan out to every active user with that role in the org
   - `group` — expand the named group's members (user / role / phone fan-out)
3. **Drops fallback rows** if any non-fallback row was found.
4. **Drops opt-outs** present in `sms_opt_outs` for this org.
5. **Dedups** by phone (`DISTINCT ON`).

If the result set is empty the outbox row is marked skipped with a clear
reason — never fired blind.

## Event catalog

| Event | Source | Default recipient_type | Trigger |
|---|---|---|---|
| `invoice_posted` | invoices | customer | DB trigger |
| `payment_received` | payments | customer | DB trigger |
| `invoice_overdue` | invoices | customer | `sms_scan_overdue_invoices()` daily 09:00 |
| `payment_reminder` | invoices | customer | manual UI only |
| `sales_order_confirmed` | sales_orders | customer | DB trigger |
| `estimate_sent` | estimates | customer | DB trigger |
| `credit_note_issued` | credit_notes | customer | DB trigger |
| `delivery_shipped` | delivery_notes | customer | DB trigger |
| `recurring_invoice_generated` | recurring_invoices | customer | (TODO: hook into generator) |
| `customer_statement_sent` | customer_statements | customer | DB trigger |
| `expense_approved` / `expense_rejected` | expenses | employee | DB trigger |
| `payroll_processed` | payslips | employee | DB trigger |
| `low_stock_alert` | stock | internal/group | `check-inventory-alerts` edge fn |
| `po_sent` | purchase_orders | vendor | DB trigger (existing) |

## Template variables

All document events get this baseline (built by `sms_build_doc_vars`):

- `customer_name` — contact's name
- `company_name` — business name (falls back to org name)
- `org_name` — organization name
- `branch_name` — branch name (when set)
- `document_number` — invoice/estimate/credit-note number
- `amount` — total, as string
- `currency` — currency code
- `due_date` — ISO date or empty
- `payment_link` — **reserved**, currently empty (no signed link infra yet)

Plus event-specific extras (e.g. `days_overdue`, `payment_date`, `reference`).
Templates that reference unknown variables render the literal `{{name}}`;
the templates editor surfaces unknown-variable warnings.

## Permissions

| Action | Required |
|---|---|
| Configure Twilio credentials | `owner` or `admin` (RLS on `sms_provider_configs`) |
| Send manual SMS | `userCanSend` in `useSmsAvailability` (org member) |
| Manage event rules / recipient groups / templates | `editSettings` permission |
| Read SMS log | `editSettings` (org-scoped) |

## Opt-out flow

`sms_opt_outs(org_id, phone_number, reason)` is checked:

- inside `resolve_rule_recipients` before returning recipients
- inside `send-sms` as a final guard (defensive — even manual sends respect it)

Inbound STOP messages handled by `sms-webhook` automatically insert opt-out rows.

## Where to extend

- **Add a new event**: extend the `sms_event_type` enum, add a default
  template, add a DB trigger that calls `sms_enqueue_event(...)`, and
  optionally add the variable keys to `src/lib/sms/eventVariables.ts`.
- **Add a new variable**: include it in `sms_build_doc_vars` (or the trigger
  itself) and document it in `eventVariables.ts` so the templates UI exposes it.
- **Add a new recipient kind**: extend `recipient_kind` text on
  `sms_event_rule_recipients` + `sms_recipient_group_members`, then add a
  branch in `resolve_rule_recipients`.

## Out of scope (today)

- Signed payment links (`payment_link` is reserved for the future)
- Two-way SMS conversations beyond STOP handling
- Marketing/bulk-SMS consent funnel (transactional flows only)
- Multi-language template localization
