import { useState } from "react";
import { ZoomIn, ZoomOut, RotateCcw } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import type {
  ExtendedReceiptSettings,
  ReceiptCompanyData,
} from "@/types/receipt";
import { PAPER_CONFIGS } from "@/lib/receiptConfig";
import {
  buildReceiptLines,
  SAMPLE_TRANSACTION,
} from "@/lib/receipt/preview/buildReceiptLines";
import { MonospacePreview } from "@/lib/receipt/preview/MonospacePreview";

interface ReceiptLivePreviewProps {
  settings: ExtendedReceiptSettings;
  companyData: ReceiptCompanyData;
  /** Kept for API compatibility — formatting is now driven by settings. */
  formatCurrency?: (amount: number) => string;
}

/**
 * Phase A.3 — true WYSIWYG monospace preview.
 *
 * Drives the same engine the ESC/POS builder uses (PrinterProfile +
 * LAYOUT_REGISTRY + solveColumns / renderHeader / renderRow + padLR /
 * wordWrap), so the on-screen receipt matches the printed receipt at the
 * column-grid level. The previous flexbox approximation has been removed
 * — it could never honour the column math the printer actually applies.
 */
export function ReceiptLivePreview({
  settings,
  companyData,
}: ReceiptLivePreviewProps) {
  const [zoom, setZoom] = useState(1);
  const paperConfig = PAPER_CONFIGS[settings.paper_size];

  const handleZoomIn = () => setZoom(Math.min(zoom + 0.1, 1.5));
  const handleZoomOut = () => setZoom(Math.max(zoom - 0.1, 0.5));
  const handleZoomReset = () => setZoom(1);

  const built = buildReceiptLines({
    settings,
    company: companyData,
    transaction: SAMPLE_TRANSACTION,
  });

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Badge variant="outline" className="text-xs">{settings.paper_size}</Badge>
          <Badge variant="outline" className="text-xs">{built.columns} cols</Badge>
          <Badge variant="outline" className="text-xs">Font {built.font}</Badge>
          {paperConfig?.isThermal && (
            <Badge variant="secondary" className="text-xs">Thermal</Badge>
          )}
        </div>
        <div className="flex items-center gap-1">
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomOut} disabled={zoom <= 0.5}>
            <ZoomOut className="h-3.5 w-3.5" />
          </Button>
          <span className="text-xs text-muted-foreground w-10 text-center">{Math.round(zoom * 100)}%</span>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomIn} disabled={zoom >= 1.5}>
            <ZoomIn className="h-3.5 w-3.5" />
          </Button>
          <Button variant="ghost" size="icon" className="h-7 w-7" onClick={handleZoomReset}>
            <RotateCcw className="h-3.5 w-3.5" />
          </Button>
        </div>
      </div>

      <ScrollArea className="h-[500px] border rounded-lg bg-muted/30">
        <div className="flex justify-center p-4">
          <div style={{ transform: `scale(${zoom})`, transformOrigin: "top center" }}>
            <MonospacePreview
              lines={built.lines}
              meta={built.meta}
              columns={built.columns}
              marginCols={built.marginCols}
              paper={built.paper}
            />
          </div>
        </div>
      </ScrollArea>

      <p className="text-xs text-muted-foreground text-center">
        WYSIWYG: this preview uses the exact same column engine the thermal
        printer uses. What you see here is what your receipt prints.
      </p>
    </div>
  );
}
