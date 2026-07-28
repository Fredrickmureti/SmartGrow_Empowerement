# Hardware surface consolidation — audit & closeout

Date: 2026-07-28
Scope: `/platform/hardware/*` admin surfaces, read-only audit followed by
removal of dead/duplicated pages.

## Question

Which of Output policies / Printer roles / Printer capability / Media
profiles are load-bearing, and which are duplication?

## Findings

| Surface | Backing data | Runtime consumer | Verdict |
|---|---|---|---|
| Output policies | `document_print_policies` | `resolve_output_intent`, `_shared/printing/resolvePolicy.ts`, `generate-document`, `src/services/printing/policy.ts` | **KEEP** — the single operator control surface |
| Printer roles | `printer_roles` (dictionary) + `printer_role_branch_bindings` | Dictionary joined by `resolve_output_intent` to map `role_code → hardware_kind`. The binding table was **dropped** in migration `20260727234102` along with `resolve_hardware_assignment` — verified `to_regclass(...) IS NULL` — so the device-binding/priority/primary half of the page queried a non-existent table | **REMOVED** — dictionary already exposed as the role dropdown in Output policies |
| Printer capability | `device_assignments.{command_language, dpi, margins_mm, supported_media_ids}` | Only `dpi` + `supported_media_ids`, read by `labelDispatch.ts` (`resolvePrinterMedia`). `command_language` / `margins_mm` never read at render time; saving `command_language` additionally rewrote `device_assignments.role`, giving that column two writers | **REMOVED** — surviving fields moved to `LabelMediaCapabilityCard` on the Devices page |
| Media profiles | `media_profiles` | `resolvePrinterMedia` (label envelope) and `resolve_label_template` ranking; ZPL/EPL render hard-fails without a match | **KEEP**, relabelled **Label media** (it does not affect receipt/A4 documents) |

## Duplication that was removed

1. Two competing device-selection narratives. The UI promised
   role → branch binding → priority; the runtime does
   role → `resolve_device` → `device_assignments`. Only the second runs.
2. Two writers for `device_assignments.role` (Devices page and the
   capability editor's `command_language` derivation).
3. Paper size implied in three places. Documents now read it from the
   policy only; `media_profiles` is scoped to label geometry, and
   `supported_media_ids` is a per-printer allowance used for warnings.

## Shipped

- Deleted `HardwareRoles.tsx` and `HardwareCapability.tsx`;
  `/platform/hardware/roles` → `policies`, `/platform/hardware/capability`
  → `devices`.
- New `src/components/hardware/LabelMediaCapabilityCard.tsx` (DPI +
  supported label media, label printers only) on the Devices page.
- "Media profiles" → "Label media" in nav and page heading.
- Output policies now shows a `device media mismatch` badge when no
  enabled device for the selected role lists media matching the chosen
  paper width (complements the existing `falls back to A4` badge).
- Guard test `src/test/architecture/dropped-printer-role-bindings.test.ts`
  fails the build if app code references the dropped table or RPC.

Nav after consolidation: Devices · Output policies · Label media · Label
templates · Diagnostics · Print queue · Topology.

## Print pipeline state at closeout

`print_jobs` for 2026-07-28 confirm the unified path: `sales.invoice`,
`sales.estimate`, `purchases.bill` dispatched `medium=escpos`,
`hardware_role=receipt_printer`, status `acked`; `sales.delivery_note`
dispatched `pdf` / `a4_printer`, `acked`. No post-fix failures.
