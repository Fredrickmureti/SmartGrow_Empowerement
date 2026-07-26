/**
 * usePrinterProfiles — Phase 2b consolidation (post-registry-merge).
 *
 * Historically this hook served rows from `printer_profiles`. The Phase 2a
 * migration collapsed that table into `device_assignments` (all hardware
 * columns — command_language, dpi, paper_size, cutter, columns_override,
 * margins_mm, supported_media_ids, etc. — now live directly on the
 * assignment row). This hook keeps the exported `PrinterProfile` shape so
 * existing consumers (`PrinterProfilesCard`, `PrinterProfilePaperMismatchAlert`,
 * `useResolvedDeviceForDocument`, `WorkflowBindingsCard`) continue to work,
 * but every read/write now goes to `device_assignments` filtered by
 * printer-like roles.
 *
 * Backwards-compat notes:
 *   - `PrinterProfile.id` is the `device_assignments.id`. The legacy
 *     `printer_profiles.id` lives on as `source_config_id` for callers
 *     that still cross-reference the old key (dropped in Phase 2c).
 *   - `is_active` maps to `device_assignments.enabled`.
 *   - Soft-delete now flips `enabled=false` on the assignment.
 *   - `businessId` scopes the list to a single legal entity; passing
 *     `null` returns every printer visible to the active org.
 */
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useOrganization } from "@/hooks/useOrganization";
import { normalizeError } from "@/services/resilience";
import type { PaperFormat } from "@/hooks/useDocumentPrintPolicies";

export type PrinterTransport =
  | "electron"
  | "local_agent"
  | "web_usb"
  | "network"
  | "browser";

export type PrinterFont = "A" | "B";
export type PrinterCutter = "none" | "partial" | "full";

export interface PrinterProfile {
  id: string;
  business_id: string | null;
  label: string;
  transport: PrinterTransport;
  address: string | null;
  paper_format: PaperFormat;
  escpos_codepage: string | null;
  is_active: boolean;
  notes: string | null;
  columns_override: number | null;
  margin_cols: number | null;
  font: PrinterFont;
  cutter: PrinterCutter;
  qr_native: boolean;
  code128_native: boolean;
  is_calibrated: boolean;
  /** New in Phase 2b — carried through so admin surfaces can bind media. */
  command_language: "zpl" | "epl" | "escpos" | "pdf" | null;
  dpi: number | null;
  paper_size: string | null;
  margins_mm: Record<string, number> | null;
  supported_media_ids: string[];
  /** Underlying device_assignments row id (same as `id`). */
  device_assignment_id: string;
  /** Legacy printer_profiles.id — retained for cross-ref during migration. */
  source_config_id: string | null;
}

export type PrinterProfileInput = Omit<
  PrinterProfile,
  | "id" | "device_assignment_id" | "source_config_id" | "business_id"
  | "is_active" | "columns_override" | "margin_cols" | "font" | "cutter"
  | "qr_native" | "code128_native" | "is_calibrated"
  | "command_language" | "dpi" | "paper_size" | "margins_mm" | "supported_media_ids"
> & {
  is_active?: boolean;
  columns_override?: number | null;
  margin_cols?: number | null;
  font?: PrinterFont;
  cutter?: PrinterCutter;
  qr_native?: boolean;
  code128_native?: boolean;
  is_calibrated?: boolean;
  command_language?: PrinterProfile["command_language"];
  dpi?: number | null;
  paper_size?: string | null;
  margins_mm?: Record<string, number> | null;
  supported_media_ids?: string[];
};

export const PRINTER_TRANSPORTS: { value: PrinterTransport; label: string; addressHint: string }[] = [
  { value: "electron", label: "Electron desktop", addressHint: "OS printer name (leave blank for default)" },
  { value: "local_agent", label: "Local print agent", addressHint: "Agent printer id, e.g. usb:Star_TSP100" },
  { value: "web_usb", label: "WebUSB", addressHint: "Vendor:Product (e.g. 0x04b8:0x0202)" },
  { value: "network", label: "Network (raw 9100)", addressHint: "host:port — e.g. 192.168.1.50:9100" },
  { value: "browser", label: "Browser print dialog", addressHint: "Not used — opens the OS dialog" },
];

const THERMAL_TRANSPORTS: PrinterTransport[] = ["electron", "local_agent", "web_usb", "network"];
const THERMAL_PAPERS: PaperFormat[] = ["80mm", "58mm", "40mm"];

/** Roles that represent "something that prints paper". */
export const PRINTER_ROLES = ["receipt_printer", "a4_printer", "label_printer"] as const;

export function isThermalCapable(p: PrinterProfile): boolean {
  return THERMAL_TRANSPORTS.includes(p.transport) && THERMAL_PAPERS.includes(p.paper_format);
}

function inferRole(paper_format: PaperFormat, cmd?: PrinterProfile["command_language"]): string {
  if (cmd === "zpl" || cmd === "epl") return "label_printer";
  if (THERMAL_PAPERS.includes(paper_format)) return "receipt_printer";
  return "a4_printer";
}

type Row = {
  id: string;
  business_id: string | null;
  display_name: string;
  transport: string;
  address: string | null;
  paper_format: string | null;
  escpos_codepage: string | null;
  enabled: boolean;
  notes: string | null;
  columns_override: number | null;
  margin_cols: number | null;
  font: string | null;
  cutter: string | null;
  qr_native: boolean | null;
  code128_native: boolean | null;
  is_calibrated: boolean;
  command_language: string | null;
  dpi: number | null;
  paper_size: string | null;
  margins_mm: Record<string, number> | null;
  supported_media_ids: string[] | null;
  source_config_id: string | null;
};

function rowToProfile(r: Row): PrinterProfile {
  return {
    id: r.id,
    device_assignment_id: r.id,
    source_config_id: r.source_config_id ?? null,
    business_id: r.business_id,
    label: r.display_name ?? "",
    transport: (r.transport as PrinterTransport) ?? "browser",
    address: r.address,
    paper_format: (r.paper_format as PaperFormat) ?? "a4",
    escpos_codepage: r.escpos_codepage,
    is_active: r.enabled,
    notes: r.notes,
    columns_override: r.columns_override,
    margin_cols: r.margin_cols,
    font: ((r.font as PrinterFont) ?? "A"),
    cutter: ((r.cutter as PrinterCutter) ?? "full"),
    qr_native: r.qr_native ?? true,
    code128_native: r.code128_native ?? true,
    is_calibrated: r.is_calibrated,
    command_language: (r.command_language as PrinterProfile["command_language"]) ?? null,
    dpi: r.dpi,
    paper_size: r.paper_size,
    margins_mm: r.margins_mm ?? null,
    supported_media_ids: r.supported_media_ids ?? [],
  };
}

const SELECT_COLS =
  "id, business_id, display_name, transport, address, paper_format, escpos_codepage, " +
  "enabled, notes, columns_override, margin_cols, font, cutter, qr_native, code128_native, " +
  "is_calibrated, command_language, dpi, paper_size, margins_mm, supported_media_ids, source_config_id";

export function usePrinterProfiles(businessId: string | null | undefined) {
  const { toast } = useToast();
  const { currentOrg } = useOrganization();
  const orgId = currentOrg?.id ?? null;

  const [profiles, setProfiles] = useState<PrinterProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!orgId) {
      setProfiles([]);
      return;
    }
    setLoading(true);
    try {
      let q = supabase
        .from("device_assignments")
        .select(SELECT_COLS)
        .eq("organization_id", orgId)
        .in("role", PRINTER_ROLES as unknown as string[])
        .order("display_name", { ascending: true });
      if (businessId) {
        q = q.or(`business_id.eq.${businessId},business_id.is.null`);
      }
      const { data, error } = await q;
      if (error) throw error;
      setProfiles(((data ?? []) as unknown as Row[]).map(rowToProfile));
    } catch (e) {
      toast({ title: "Failed to load printer profiles", description: normalizeError(e).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [orgId, businessId, toast]);

  useEffect(() => { void refresh(); }, [refresh]);

  const create = useCallback(
    async (input: PrinterProfileInput) => {
      if (!orgId) return false;
      setSaving(true);
      try {
        const role = inferRole(input.paper_format, input.command_language ?? null);
        const { error } = await supabase.from("device_assignments").insert({
          organization_id: orgId,
          business_id: businessId ?? null,
          scope_kind: "tenant",
          scope_id: null,
          role,
          transport: input.transport,
          driver: "generic",
          display_name: input.label,
          config: {},
          capabilities: {},
          enabled: input.is_active ?? true,
          is_default: false,
          status: "unknown",
          address: input.address || null,
          paper_format: input.paper_format,
          paper_size: input.paper_size ?? (THERMAL_PAPERS.includes(input.paper_format) ? input.paper_format : null),
          command_language: input.command_language ?? null,
          dpi: input.dpi ?? null,
          escpos_codepage: input.escpos_codepage || null,
          columns_override: input.columns_override ?? null,
          margin_cols: input.margin_cols ?? null,
          font: input.font ?? "A",
          cutter: input.cutter ?? "full",
          qr_native: input.qr_native ?? true,
          code128_native: input.code128_native ?? true,
          is_calibrated: input.is_calibrated ?? false,
          margins_mm: input.margins_mm ?? {},
          supported_media_ids: input.supported_media_ids ?? [],
          notes: input.notes || null,
        } as never);
        if (error) throw error;
        await refresh();
        toast({ title: "Printer added" });
        return true;
      } catch (e) {
        toast({ title: "Failed to add printer", description: normalizeError(e).message, variant: "destructive" });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [orgId, businessId, refresh, toast],
  );

  const update = useCallback(
    async (id: string, patch: Partial<PrinterProfileInput>) => {
      setSaving(true);
      try {
        const payload: Record<string, unknown> = {};
        if ("label" in patch) payload.display_name = patch.label;
        if ("transport" in patch) payload.transport = patch.transport;
        if ("address" in patch) payload.address = patch.address || null;
        if ("paper_format" in patch) payload.paper_format = patch.paper_format;
        if ("paper_size" in patch) payload.paper_size = patch.paper_size ?? null;
        if ("command_language" in patch) payload.command_language = patch.command_language ?? null;
        if ("dpi" in patch) payload.dpi = patch.dpi ?? null;
        if ("escpos_codepage" in patch) payload.escpos_codepage = patch.escpos_codepage || null;
        if ("notes" in patch) payload.notes = patch.notes || null;
        if ("is_active" in patch) payload.enabled = patch.is_active;
        if ("columns_override" in patch) payload.columns_override = patch.columns_override ?? null;
        if ("margin_cols" in patch) payload.margin_cols = patch.margin_cols ?? null;
        if ("font" in patch) payload.font = patch.font;
        if ("cutter" in patch) payload.cutter = patch.cutter;
        if ("qr_native" in patch) payload.qr_native = patch.qr_native;
        if ("code128_native" in patch) payload.code128_native = patch.code128_native;
        if ("is_calibrated" in patch) payload.is_calibrated = patch.is_calibrated;
        if ("margins_mm" in patch) payload.margins_mm = patch.margins_mm ?? {};
        if ("supported_media_ids" in patch) payload.supported_media_ids = patch.supported_media_ids ?? [];
        // If paper_format changes, keep role coherent.
        if ("paper_format" in patch || "command_language" in patch) {
          const target = profiles.find((p) => p.id === id);
          const nextFmt = (patch.paper_format ?? target?.paper_format ?? "a4") as PaperFormat;
          const nextCmd = (patch.command_language ?? target?.command_language ?? null) as PrinterProfile["command_language"];
          payload.role = inferRole(nextFmt, nextCmd);
        }
        const { error } = await supabase
          .from("device_assignments")
          .update(payload as never)
          .eq("id", id);
        if (error) throw error;
        await refresh();
        toast({ title: "Printer updated" });
        return true;
      } catch (e) {
        toast({ title: "Failed to update printer", description: normalizeError(e).message, variant: "destructive" });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [profiles, refresh, toast],
  );

  const remove = useCallback(
    async (id: string) => {
      setSaving(true);
      try {
        // Soft-delete via enabled=false, mirroring the legacy is_active flip.
        // Bindings ON DELETE CASCADE if a hard delete is performed later.
        const { error } = await supabase
          .from("device_assignments")
          .update({ enabled: false } as never)
          .eq("id", id);
        if (error) throw error;
        await refresh();
        toast({ title: "Printer removed" });
        return true;
      } catch (e) {
        toast({ title: "Failed to remove printer", description: normalizeError(e).message, variant: "destructive" });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refresh, toast],
  );

  const findById = useCallback(
    (id: string | null | undefined) => {
      if (!id) return null;
      return (
        profiles.find((p) => p.id === id) ??
        profiles.find((p) => p.source_config_id === id) ??
        null
      );
    },
    [profiles],
  );

  const activeProfiles = profiles.filter((p) => p.is_active);

  return { profiles, activeProfiles, loading, saving, refresh, create, update, remove, findById };
}
