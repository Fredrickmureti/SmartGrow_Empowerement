import { normalizeError } from "@/services/resilience";
/**
 * usePrinterProfiles — Wave W7 follow-up (ADR-0008).
 *
 * CRUD over `printer_profiles` for the active business. Mirrors
 * `useDocumentPrintPolicies` shape so the settings UI stays consistent.
 *
 * Writes require owner/admin/accountant (RLS enforces this); the hook
 * surfaces success/failure via toasts and the `saving` flag.
 *
 * Delete is soft (sets `is_active=false`) so existing
 * `document_print_policies.printer_profile_id` references stay readable
 * in audit history. The FK is `ON DELETE SET NULL` so a hard delete is
 * also safe — soft is just friendlier.
 */
import { useEffect, useState, useCallback } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
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
  business_id: string;
  label: string;
  transport: PrinterTransport;
  address: string | null;
  paper_format: PaperFormat;
  escpos_codepage: string | null;
  is_active: boolean;
  notes: string | null;
  // Phase A — physical capabilities consumed by the ESC/POS builder.
  columns_override: number | null;
  margin_cols: number | null;
  font: PrinterFont;
  cutter: PrinterCutter;
  qr_native: boolean;
  code128_native: boolean;
}

export type PrinterProfileInput = Omit<
  PrinterProfile,
  "id" | "business_id" | "is_active" | "columns_override" | "margin_cols" | "font" | "cutter" | "qr_native" | "code128_native"
> & {
  is_active?: boolean;
  columns_override?: number | null;
  margin_cols?: number | null;
  font?: PrinterFont;
  cutter?: PrinterCutter;
  qr_native?: boolean;
  code128_native?: boolean;
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

export function isThermalCapable(p: PrinterProfile): boolean {
  return THERMAL_TRANSPORTS.includes(p.transport) && THERMAL_PAPERS.includes(p.paper_format);
}

export function usePrinterProfiles(businessId: string | null | undefined) {
  const { toast } = useToast();
  const [profiles, setProfiles] = useState<PrinterProfile[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);

  const refresh = useCallback(async () => {
    if (!businessId) {
      setProfiles([]);
      return;
    }
    setLoading(true);
    try {
      const { data, error } = await supabase
        .from("printer_profiles")
        .select(
          "id, business_id, label, transport, address, paper_format, escpos_codepage, is_active, notes, columns_override, margin_cols, font, cutter, qr_native, code128_native",
        )
        .eq("business_id", businessId)
        .order("label", { ascending: true });
      if (error) throw error;
      setProfiles((data ?? []) as PrinterProfile[]);
    } catch (e: any) {
      toast({ title: "Failed to load printer profiles", description: normalizeError(e).message, variant: "destructive" });
    } finally {
      setLoading(false);
    }
  }, [businessId, toast]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const create = useCallback(
    async (input: PrinterProfileInput) => {
      if (!businessId) return false;
      setSaving(true);
      try {
        const { error } = await supabase.from("printer_profiles").insert({
          business_id: businessId,
          label: input.label,
          transport: input.transport,
          address: input.address || null,
          paper_format: input.paper_format,
          escpos_codepage: input.escpos_codepage || null,
          notes: input.notes || null,
          is_active: input.is_active ?? true,
          columns_override: input.columns_override ?? null,
          margin_cols: input.margin_cols ?? null,
          font: input.font ?? "A",
          cutter: input.cutter ?? "full",
          qr_native: input.qr_native ?? true,
          code128_native: input.code128_native ?? true,
        });
        if (error) throw error;
        await refresh();
        toast({ title: "Printer added" });
        return true;
      } catch (e: any) {
        toast({ title: "Failed to add printer", description: normalizeError(e).message, variant: "destructive" });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [businessId, refresh, toast],
  );

  const update = useCallback(
    async (id: string, patch: Partial<PrinterProfileInput>) => {
      setSaving(true);
      try {
        const cleaned: Partial<PrinterProfileInput> = { ...patch };
        if ("address" in cleaned) cleaned.address = (cleaned.address || null) as any;
        if ("escpos_codepage" in cleaned) cleaned.escpos_codepage = (cleaned.escpos_codepage || null) as any;
        if ("notes" in cleaned) cleaned.notes = (cleaned.notes || null) as any;
        const { error } = await supabase.from("printer_profiles").update(cleaned as any).eq("id", id);
        if (error) throw error;
        await refresh();
        toast({ title: "Printer updated" });
        return true;
      } catch (e: any) {
        toast({ title: "Failed to update printer", description: normalizeError(e).message, variant: "destructive" });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refresh, toast],
  );

  const remove = useCallback(
    async (id: string) => {
      setSaving(true);
      try {
        // Soft-delete to preserve FK references in document_print_policies.
        const { error } = await supabase
          .from("printer_profiles")
          .update({ is_active: false })
          .eq("id", id);
        if (error) throw error;
        await refresh();
        toast({ title: "Printer removed" });
        return true;
      } catch (e: any) {
        toast({ title: "Failed to remove printer", description: normalizeError(e).message, variant: "destructive" });
        return false;
      } finally {
        setSaving(false);
      }
    },
    [refresh, toast],
  );

  const findById = useCallback(
    (id: string | null | undefined) => (id ? profiles.find((p) => p.id === id) ?? null : null),
    [profiles],
  );

  const activeProfiles = profiles.filter((p) => p.is_active);

  return { profiles, activeProfiles, loading, saving, refresh, create, update, remove, findById };
}
