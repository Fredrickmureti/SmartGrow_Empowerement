/**
 * Wave 9d Phase 5 — legacy `printer_profiles` → unified surface mapping.
 *
 * The Hardware Platform audit committed to deleting `printer_profiles`
 * in Phase 6. Before deletion, every column must have a documented home
 * on the new surfaces so no operator loses a knob silently.
 *
 * Homes:
 *   - `assignment.<field>`  — direct column on `device_assignments`.
 *   - `assignment.config.<key>` — free-form JSON config on the
 *     assignment (surfaced by DeviceWizard's Config JSON textarea).
 *   - `assignment.capabilities.<key>` — capabilities JSON on the
 *     assignment (surfaced as flags by CommandRouter).
 *   - `policy.<field>` — column on `document_print_policies` (edited
 *     under `/platform/hardware/policies`).
 *   - `media_profile.<field>` — column on `printer_media_profiles`
 *     (edited under `/platform/hardware/media`).
 *   - `LEGACY_DROPPED` — intentionally not migrated; Phase 6 drops it
 *     with an explicit ADR entry (see notes).
 *
 * The architectural test `legacy-printer-profile-field-parity.test.ts`
 * asserts every column in `printer_profiles` has an entry here, and
 * that this file is imported nowhere at runtime (mapping-only).
 */
export type FieldHome =
  | { kind: "assignment"; field: string }
  | { kind: "assignment.config"; key: string }
  | { kind: "assignment.capabilities"; key: string }
  | { kind: "policy"; field: string }
  | { kind: "media_profile"; field: string }
  | { kind: "LEGACY_DROPPED"; reason: string };

export const LEGACY_PRINTER_PROFILE_FIELD_MAP: Record<string, FieldHome> = {
  // Identity ---------------------------------------------------------------
  id:               { kind: "LEGACY_DROPPED", reason: "device_assignments.id is the new PK" },
  business_id:      { kind: "assignment", field: "business_id" },
  label:            { kind: "assignment", field: "display_name" },
  notes:            { kind: "assignment.config", key: "notes" },
  is_active:        { kind: "assignment", field: "enabled" },
  created_at:       { kind: "assignment", field: "created_at" },
  updated_at:       { kind: "assignment", field: "updated_at" },

  // Transport / addressing -------------------------------------------------
  transport:        { kind: "assignment", field: "transport" },
  address:          { kind: "assignment.config", key: "address" }, // host:port / device path

  // Driver / command language ---------------------------------------------
  command_language: { kind: "assignment", field: "driver" },       // escpos/zpl/…
  escpos_codepage:  { kind: "assignment.config", key: "escpos_codepage" },
  cutter:           { kind: "assignment.config", key: "cutter" },
  font:             { kind: "assignment.config", key: "font" },

  // Geometry — moves to document policy / media profile -------------------
  paper_format:     { kind: "policy",        field: "paper_format" },
  paper_size:       { kind: "LEGACY_DROPPED", reason: "derived from paper_format" },
  columns_override: { kind: "media_profile", field: "columns" },
  margin_cols:      { kind: "media_profile", field: "margin_cols" },
  margins_mm:       { kind: "media_profile", field: "margins_mm" },
  dpi:              { kind: "media_profile", field: "dpi" },

  // Capabilities -----------------------------------------------------------
  capabilities:     { kind: "assignment", field: "capabilities" },
  code128_native:   { kind: "assignment.capabilities", key: "code128_native" },
  qr_native:        { kind: "assignment.capabilities", key: "qr_native" },

  // Media catalog wiring --------------------------------------------------
  supported_media_ids: { kind: "media_profile", field: "supported_media_ids" },

  // Calibration ------------------------------------------------------------
  is_calibrated:    { kind: "assignment.capabilities", key: "calibrated" },
};
