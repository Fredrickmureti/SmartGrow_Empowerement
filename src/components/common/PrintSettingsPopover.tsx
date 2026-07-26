/**
 * Print Settings Popover (Phase 4 — ADR-0008)
 *
 * Per-print paper override for the PDF preview surface. Default behaviour
 * is silently inherited from the resolved `document_print_policies` row,
 * so callers that never open this popover behave exactly as before.
 *
 * Phase 4 change: thermal paper sizes (40 / 58 / 80 mm) are now first-class
 * options here. `PdfBuilder` renders receipt-width PDFs via `density:
 * "narrow"`, and `coercePaperRenderMode` treats thermal + PDF as legal for
 * every document type routed through `generate-document`. Render mode is
 * still locked to PDF on this surface — physical ESC/POS streaming is a
 * hardware concern owned by the POS receipt surface.
 */

import { useState } from "react";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Settings2 } from "lucide-react";
import type { PaperFormatOption } from "@/services/printing/pdfUtils";

export type PrintSettings = {
  paperFormat: Extract<PaperFormatOption, string>;
  renderMode: "pdf" | "escpos";
};

// PDF preview surface: printable and thermal-width PDFs are both legal.
const PAPER_OPTIONS: { value: PrintSettings["paperFormat"]; label: string }[] = [
  { value: "a4", label: "A4 (210 × 297 mm)" },
  { value: "letter", label: "US Letter (216 × 279 mm)" },
  { value: "a5", label: "A5 (148 × 210 mm)" },
  { value: "80mm", label: "Thermal 80 mm" },
  { value: "58mm", label: "Thermal 58 mm" },
  { value: "40mm", label: "Thermal 40 mm" },
];

interface Props {
  value: PrintSettings;
  onChange: (next: PrintSettings) => void;
  /** When true, disables interaction (e.g. while a re-render is in flight). */
  disabled?: boolean;
}

export function PrintSettingsPopover({ value, onChange, disabled }: Props) {
  const [open, setOpen] = useState(false);

  const handlePaperChange = (next: PrintSettings["paperFormat"]) => {
    // Render mode is locked to PDF on this surface — thermal output is a
    // hardware concern, not a preview concern.
    onChange({ paperFormat: next, renderMode: "pdf" });
  };

  // Coerce previously-saved thermal selections back to A4 so a stale
  // value never leaks into the dropdown's `value`.
  const safePaper = PAPER_OPTIONS.some((p) => p.value === value.paperFormat)
    ? value.paperFormat
    : "a4";

  return (
    <Popover open={open} onOpenChange={(o) => !disabled && setOpen(o)}>
      <PopoverTrigger asChild>
        <Button
          variant="outline"
          size="sm"
          className="h-8 sm:h-9 text-xs sm:text-sm"
          disabled={disabled}
        >
          <Settings2 className="h-3.5 w-3.5 sm:h-4 sm:w-4 mr-1.5" />
          Paper
        </Button>
      </PopoverTrigger>
      <PopoverContent align="end" className="w-72 space-y-3">
        <div className="space-y-1">
          <h4 className="text-sm font-medium leading-none">Paper override</h4>
          <p className="text-xs text-muted-foreground">
            One-off override for this print only. Permanent paper and
            thermal-printer routing live in Settings → Printing.
          </p>
        </div>

        <div className="space-y-1.5">
          <Label className="text-xs">Paper format</Label>
          <Select
            value={safePaper}
            onValueChange={(v) => handlePaperChange(v as PrintSettings["paperFormat"])}
          >
            <SelectTrigger className="h-9">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {PAPER_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </PopoverContent>
    </Popover>
  );
}
