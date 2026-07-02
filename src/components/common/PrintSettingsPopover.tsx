/**
 * Print Settings Popover (W3, ADR-0008)
 *
 * Per-print paper override for NON-POS documents (invoices, estimates,
 * bills, statements, …). Default behaviour is silently inherited from the
 * resolved `document_print_policies` row, so callers that never open this
 * popover behave exactly as before.
 *
 * W3 demotion: thermal paper sizes (80 mm / 58 mm) and `escpos` render
 * mode are intentionally NOT exposed here. Rendering an A4 invoice as a
 * tall narrow PDF preview in the browser is a category error — thermal
 * paper is meant to stream as ESC/POS bytes to a connected printer, not
 * be previewed in an iframe. Thermal print policy is configured per
 * document type in Settings → Printing and routed by the hardware layer
 * (the POS receipt surface keeps its own thermal preview).
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
import type { PaperFormatOption } from "@/hooks/useDocumentPrint";

export type PrintSettings = {
  paperFormat: Extract<PaperFormatOption, string>;
  renderMode: "pdf" | "escpos";
};

// Non-POS preview surface: only printable paper sizes that make sense in a
// PDF viewer. Thermal sizes are excluded by design — see file header.
const PAPER_OPTIONS: { value: PrintSettings["paperFormat"]; label: string }[] = [
  { value: "a4", label: "A4 (210 × 297 mm)" },
  { value: "letter", label: "US Letter (216 × 279 mm)" },
  { value: "a5", label: "A5 (148 × 210 mm)" },
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
