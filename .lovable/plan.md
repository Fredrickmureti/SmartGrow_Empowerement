## Part 1 — Print pipeline confirmation (verified, not assumed)

Live `print_jobs` rows from today:

| Time | Document | medium | hardware_role | status |
|---|---|---|---|---|
| 18:22 | purchases.bill | escpos | receipt_printer | acked |
| 18:20 | sales.delivery_note | pdf | a4_printer | acked |
| 18:20 | sales.estimate | escpos | receipt_printer | acked |
| 18:18 | sales.invoice | escpos | receipt_printer | acked |
| 16:31 | pos_receipt | escpos | — | acked |

Older `failed` / `dead_letter` rows are all pre-fix (≤15:55, plus the 14:23 batch). Sales + Purchases now go thermal when policy says thermal and A4 PDF when policy says A4, using the same path as POS and labels. Nothing else needs fixing for printing.

## Part 2 — Verdicts on the four Hardware pages

### 1. Output policies — KEEP (load-bearing, the real control surface)
Table: `document_print_policies` (8 rows configured). Read directly by `resolve_output_intent`, `_shared/printing/resolvePolicy.ts`, `generate-document`, `src/services/printing/policy.ts`. This is the only page an operator actually needs: it sets paper format, medium, trigger, and role per document type. Your instinct is right.

### 2. Printer roles — MOSTLY DEAD, HALF ALREADY BROKEN
- The **roles list** (`printer_roles`, 5 rows) is still consulted: `resolve_output_intent` joins it to translate the policy's `role_code` → `hardware_kind` (`receipt_printer`/`label_printer`/`kitchen_printer`/`a4_printer`). So the table is load-bearing, but only as a lookup dictionary of 5 fixed values.
- The **bindings half of the page** — per-branch device binding, priority ordering, primary star, ~60% of the UI — reads/writes `printer_role_branch_bindings`. **That table does not exist**: verified `to_regclass('public.printer_role_branch_bindings')` returns NULL; it was dropped in migration `20260727234102` along with its `resolve_hardware_assignment` RPC. Every query on that page half fails at runtime. The header comment describing "the dispatcher walks bindings in priority order" documents a pipeline that no longer exists.
- Real device selection today is `resolve_device(role, business_id, scope)` querying `device_assignments` directly.

Verdict: delete the page. Fold the 5 role codes into the role dropdown that already exists inside Output policies (it already shows them). Keep the `printer_roles` table as a seed dictionary.

### 3. Printer capability — PARTIALLY USED, mostly decoration
No separate table — it edits four columns on `device_assignments`.

| Field | Runtime consumer | Verdict |
|---|---|---|
| `supported_media_ids` | `labelDispatch.ts` media fallback tier | used (labels only) |
| `dpi` | `labelDispatch.ts` envelope math | used (labels only) |
| `command_language` | never read at render time; only indirectly, because saving it overwrites `device_assignments.role` | duplicate of the device's role, set in two places |
| `margins_mm` | **never read anywhere** — exhaustive grep across `src/`, `supabase/functions/`, `electron/` | dead |

Verdict: not worth its own top-level page. Move `dpi` + `supported_media_ids` into the device row on the Devices page (where `role` is already set), drop `margins_mm`, stop letting this page rewrite `role`.

### 4. Media profiles — KEEP, but it is label-only
Table: `media_profiles` (8 rows). Genuinely load-bearing for ZPL/EPL label rendering: `resolvePrinterMedia` resolves width/height/DPI and label rendering **hard-fails** without a match; also ranks label templates via `resolve_label_template`. Note `print_jobs.media_profile_id` is NULL on all rows so far, i.e. no label job has been dispatched through it yet in your data. It does **not** participate in receipt/A4 document printing at all.

Verdict: keep, but relabel it as label media so it isn't confused with the paper sizes in Output policies.

## Part 3 — Duplication map (the confusing bits)

1. **Paper size lives in 3 places**: `document_print_policies.paper_format` (80mm/A4 — the one you use), `media_profiles.width_mm/height_mm` (label geometry), `device_assignments.supported_media_ids` (per-printer allowance). Nothing cross-checks them, so a 40mm policy pointed at an 80mm-only device is caught nowhere before dispatch.
2. **Role lives in 2 enums**: `printer_roles.hardware_kind` is a friendly-label wrapper over the same 4 values as `device_assignments.role`.
3. **`device_assignments.role` is written by 2 editors**: Devices page (on create) and Printer capability (derived from `command_language`).
4. **Device selection has 2 narratives**: the UI promises role→branch binding→priority; the runtime does role→`resolve_device`→`device_assignments`. Only the second one runs.

## Part 4 — Proposed cleanup

**Step 1 — Remove Printer roles page**
Delete `src/apps/platform/hardware/HardwareRoles.tsx`, its route in `routes.tsx`, and its nav entry. Redirect `/platform/hardware/roles` → `/platform/hardware/policies`. Keep the `printer_roles` table (the resolver needs it); the Output policies role dropdown already reads it.

**Step 2 — Fold Printer capability into Devices**
Move `dpi` and `supported_media_ids` editing into the device detail/edit surface on `HardwareDevices.tsx` (shown only when the device role is `label_printer`, since that's the only consumer). Remove `command_language` and `margins_mm` from the UI so `role` has one writer. Delete `HardwareCapability.tsx`, its route and nav entry; redirect to `/platform/hardware/devices`.

**Step 3 — Rename Media profiles → "Label media"**
Nav label + page heading only, with a one-line note that document paper sizes are set in Output policies. No schema change.

**Step 4 — Close the mismatch gap in Output policies**
The "falls back to A4" badge already added covers role mismatch. Add the same treatment for device capability: if the resolved device's `supported_media_ids` doesn't include the selected paper format, show a warning on the policy row. Presentation-only, no resolver change.

**Step 5 — Doc + guard cleanup**
Update `docs/architecture/HARDWARE_RUNTIME.md` / ADR-0026 to delete the printer-role-binding narrative, and add an architecture test asserting no source file references `printer_role_branch_bindings` or `resolve_hardware_assignment` (both dropped) so the phantom pipeline can't be reintroduced.

### Technical notes
- No migration is required for steps 1–4. `printer_roles` and `media_profiles` stay; `command_language`/`margins_mm` columns stay in the DB (unused, harmless) and can be dropped in a later migration once nothing references them.
- Nav after cleanup: Devices · Label media · Output policies · Diagnostics · Print queue · Topology — six surfaces instead of nine, with exactly one place to configure how a document prints.
