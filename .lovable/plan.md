
# Hardware app — routing model consolidation

## The real problem

The hardware app currently expresses "how does a document reach a printer" **three different ways**, built in three different waves, all still wired in parallel:

| # | Surface | Table | What it decides | Wave |
|---|---|---|---|---|
| 1 | **Print policies** | `document_print_policies` | (doc_type, branch) → paper format + render_mode + optional `device_assignment_id` + `auto_print` | V3 |
| 2 | **Printer roles** | `printer_roles` + `printer_role_branch_bindings` | doc intent → role → per-branch device (with priority + primary + fallback) | Wave 6 |
| 3 | **Output intent** | `output_intent_targets` | doc_type → (medium, disposition, hardware_role) | Wave 7 |

Sales/Purchases/Inventory don't "know their hardware." They call `submitDocumentIntent(doc_type, doc_id)`. The server-side resolver is supposed to walk **one** of these chains to a device. Today it walks a hybrid: it reads `output_intent_targets` for the medium/disposition, sometimes reads `print_policies` for a device, and Printer Roles are only consulted from POS/Labels via a different code path (`resolve_hardware_assignment`).

That is why:
- POS receipt + labels work — they go through Printer Roles + `SharedCommandQueueWorker`.
- Invoice/Estimate print returns "queued to 1 target(s)" — the intent row is written, but no worker knows how to convert `disposition:download` (default) or a `hardware_role` (that isn't bound) into a physical target.
- The Printer column and Auto switch in Print Policies are disabled for everything except `pos_receipt` — the UI is honest that this part was never finished.
- The "Reserved for printer profiles (V6)" tooltip is a fossil: V6 = Printer Roles, which already exists as its own module. The Print Policies row was left in place as a placeholder that never got deleted.

## How big platforms actually model this

Every mature system separates **four independent axes**. Our three tables mash them together.

| Axis | Answers | Example values | Where it belongs |
|---|---|---|---|
| **Format** | What does the document look like on paper? | A4 / A5 / Letter / 80mm / 58mm / 40mm | Document template (media profile) |
| **Rendering** | How is it encoded for the device? | PDF / ESC/POS / ZPL / HTML-print | Derived from printer capability, not user-chosen |
| **Routing** | Which physical device handles this class of output? | "receipt_thermal", "office_a4", "shipping_label" → device per branch | Printer role + branch binding |
| **Trigger** | When does it print vs preview vs download? | manual preview / auto on commit / email / download | Per (doc_type, branch) policy |

- **Square / Toast / Lightspeed**: printer *roles* (receipt / kitchen / bar / expo / label). Each device subscribes to roles. Documents ask for a role, never for a device. Fallback is by priority order among devices bound to the same role.
- **Odoo**: paper format lives on the report/template; IoT-box printer is picked per (company, report). No separate "role" concept, but effectively one printer per report is a degenerate role.
- **NetSuite / SAP / QuickBooks**: format template ≠ output channel. User picks "print / email / save PDF" at action time; browser/OS default printer handles physical routing. No app-level device registry.
- **Shopify POS**: hard split between "receipt printer" (role) and "label/shipping printer" (role). No user-visible device list per document.

The consistent pattern: **format is a template property, routing is a role, rendering is a driver detail, trigger is a policy.** We currently have all four fighting each other across three tables.

## Target model (Square-style, one coherent chain)

```text
Document (invoice INV-00001)
        │
        ▼  submitDocumentIntent(doc_type='invoice', doc_id, action='print'|'preview'|'download'|'email')
        │
        ▼  Output policy   (doc_type, branch) → { format, trigger, target_role }
        │                    - format:  A4 / 80mm / ...          (from Media profiles)
        │                    - trigger: auto | manual | preview-only
        │                    - role:    printer_role code        (from Printer roles)
        │
        ▼  Role binding   (role, branch)      → device_assignment (priority + fallback)
        │
        ▼  Capability      (device)            → render_mode + driver bytes
        │
        ▼  Transport router (device.transport) → electron | agent | webusb | ...
        │
        ▼  hardware_command_queue → physical print
```

One resolver walks this chain. Every module in the hardware app maps to exactly one hop:

| Hardware module | Owns | Answers |
|---|---|---|
| Devices | `device_assignments` | What physical hardware exists per branch? |
| Media profiles | media geometry catalog | What paper sizes/labels are defined? |
| Printer capability | driver + DPI + supported media per device | Can this printer render this format? |
| Label templates | template AST | How does the payload lay out for a given media? |
| **Printer roles** | `printer_roles` + bindings | Which device handles a given semantic role, per branch? |
| **Output policies** (renamed from "Print policies") | (doc_type, branch) → format + trigger + role | For this document type, what should happen and where does it go? |
| Print queue | `print_jobs` | Live status of ongoing dispatches. |

## What has to change

### 1. Print Policies → Output Policies (rewrite the row semantics)
Row becomes `{ business, branch, doc_type, format, trigger, role_code }`. Drop the `device_assignment_id` column (that decision moved to role bindings) and drop `render_mode` (derived from role's device capability). The disabled printer dropdown and disabled Auto switch **go away entirely** — they were placeholders for role work that is now done in the Printer roles module.

### 2. Resolver becomes single-pass
Server-side `resolve_output_intent` is rewritten to walk exactly one chain: policy → role → binding → device → capability. If any hop is missing, the intent stops at `preview` (never silently `download`) and the reason is stored on `print_jobs.status_reason` so the "Print queue" surface actually shows why nothing printed.

### 3. Sales / Purchases / Inventory stay untouched
They already call `submitDocumentIntent(doc_type, doc_id, action)`. They never see roles or devices. This is the load-bearing contract and it's already correct — the fix is entirely under it.

### 4. Delete the shadow paths
- Remove the `device_assignment_id` column reference from `document_print_policies` (migrate any existing rows into a role binding first).
- Remove the Auto switch + Printer dropdown from the Print Policies editor.
- Remove the "Reserved for printer profiles (V6)" tooltip fossil.
- The POS receipt "auto-print on commit" trigger moves onto the new `output_policies.trigger = 'auto'` field, so POS uses the same model as everything else.

### 5. Print queue surface must show failures
Today a stuck `queued` row is invisible from the originating document. The Print queue module already exists; wire `print_jobs.status_reason` into it and add a "See failed jobs" link inside every document action toast, so "queued to 1 target(s)" is either followed by a success toast or by a visible failure with a jump link.

## Technical details (server + tables)

- New/renamed table: `output_policies` (business_id, branch_id nullable, document_type, media_profile_id, trigger enum('auto','manual','preview_only','download_only'), role_code nullable). Backfill from `document_print_policies` + inferred role for POS rows.
- New RPC: `resolve_output_route(doc_type, doc_id, branch_id) → { format, trigger, role_code, device_assignment_id | null, render_mode, reason }`. Called once from `submit-document-intent`.
- Deprecate `print_policies_resolve` and the mixed `resolve_output_intent` — one entry point only.
- `dispatch-print-jobs` worker no longer inspects intent targets to guess a device; it only reads the resolved route stamped onto `print_jobs` at enqueue time.
- Keep `SharedCommandQueueWorker` as the last-mile executor. Both POS and non-POS jobs flow through `print_jobs` → `hardware_command_queue` after this change, killing the split-brain.

## Out of scope (explicitly)

- No changes to Devices, Media profiles, Printer capability, or Label templates modules. Their models are already correct.
- No new drivers, no Bluetooth work, no changes to the Electron main-process orchestrator (ADR-0014 stays).
- No UI theming or navigation changes beyond renaming "Print policies" → "Output policies".

## Open decision I'd like your call on before I start

**Do we hard-migrate `document_print_policies` rows into the new `output_policies` shape and drop the old table, or run both side-by-side for one release with a read shim?** Hard migration is cleaner and matches how the rest of your codebase treats deprecations; the shim is safer if there are external integrations reading `document_print_policies` directly. My default is hard-migrate unless you tell me otherwise.
