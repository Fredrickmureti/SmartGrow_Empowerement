import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Download, FileSpreadsheet, FileJson } from "lucide-react";
import { Estimate } from "@/hooks/useEstimates";
import { useExport } from "@/hooks/useExport";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";
import { DetailSheet } from "@/design-system/primitives/DetailSheet";
import { FooterActionBar } from "@/design-system/primitives/FooterActionBar";

interface BulkExportEstimatesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedEstimates: Estimate[];
  allEstimates: Estimate[];
}

const EXPORT_FIELDS = [
  { key: "estimate_number", label: "Estimate Number", default: true },
  { key: "customer", label: "Customer", default: true },
  { key: "issue_date", label: "Issue Date", default: true },
  { key: "expiry_date", label: "Expiry Date", default: true },
  { key: "status", label: "Status", default: true },
  { key: "subtotal", label: "Subtotal", default: true },
  { key: "tax_amount", label: "Tax Amount", default: true },
  { key: "discount_amount", label: "Discount", default: true },
  { key: "total", label: "Total", default: true },
  { key: "currency", label: "Currency", default: true },
  { key: "notes", label: "Notes", default: false },
  { key: "terms", label: "Terms", default: false },
];

export function BulkExportEstimatesDialog({
  open,
  onOpenChange,
  selectedEstimates,
  allEstimates,
}: BulkExportEstimatesDialogProps) {
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [exportScope, setExportScope] = useState<"selected" | "all">("selected");
  const [selectedFields, setSelectedFields] = useState<string[]>(
    EXPORT_FIELDS.filter((f) => f.default).map((f) => f.key)
  );
  const { exportToCSV, exportToJSON } = useExport();
  const { toast } = useToast();

  const estimatesToExport = exportScope === "selected" ? selectedEstimates : allEstimates;

  const handleFieldToggle = (key: string) => {
    setSelectedFields((prev) =>
      prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]
    );
  };

  const handleExport = () => {
    if (estimatesToExport.length === 0) {
      toast({
        title: "No estimates to export",
        description: "Please select at least one estimate to export.",
        variant: "destructive",
      });
      return;
    }

    const data = estimatesToExport.map((est) => {
      const row: Record<string, any> = {};
      if (selectedFields.includes("estimate_number")) row.estimate_number = est.estimate_number;
      if (selectedFields.includes("customer")) row.customer = est.contact?.name || "";
      if (selectedFields.includes("issue_date")) row.issue_date = est.issue_date;
      if (selectedFields.includes("expiry_date")) row.expiry_date = est.expiry_date;
      if (selectedFields.includes("status")) row.status = est.status;
      if (selectedFields.includes("subtotal")) row.subtotal = est.subtotal;
      if (selectedFields.includes("tax_amount")) row.tax_amount = est.tax_amount;
      if (selectedFields.includes("discount_amount")) row.discount_amount = est.discount_amount;
      if (selectedFields.includes("total")) row.total = est.total;
      if (selectedFields.includes("currency")) row.currency = est.currency;
      if (selectedFields.includes("notes")) row.notes = est.notes || "";
      if (selectedFields.includes("terms")) row.terms = est.terms || "";
      return row;
    });

    const filename = `estimates_${new Date().toISOString().split("T")[0]}`;

    try {
      if (format === "csv") {
        exportToCSV(data, { filename, headers: selectedFields });
      } else {
        exportToJSON(data, { filename });
      }
      toast({
        title: "Export successful",
        description: `Exported ${estimatesToExport.length} estimates as ${format.toUpperCase()}.`,
      });
      onOpenChange(false);
    } catch (error: any) {
      toast({
        title: "Export failed",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex items-center gap-2">
          <Download className="h-5 w-5" />
          Export Estimates
        </span>
      }
      description="Export estimates to CSV or JSON format for use in other applications."
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          }
          trailing={
            <Button onClick={handleExport} disabled={selectedFields.length === 0}>
              <Download className="mr-2 h-4 w-4" />
              Export {estimatesToExport.length} Estimate{estimatesToExport.length !== 1 ? "s" : ""}
            </Button>
          }
        />
      }
    >
      <div className="space-y-6">
        {/* Export Scope */}
        <div className="space-y-3">
          <Label>What to export</Label>
          <RadioGroup value={exportScope} onValueChange={(v: "selected" | "all") => setExportScope(v)}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="selected" id="selected" />
              <Label htmlFor="selected" className="font-normal cursor-pointer">
                Selected estimates ({selectedEstimates.length})
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="all" id="all" />
              <Label htmlFor="all" className="font-normal cursor-pointer">
                All estimates ({allEstimates.length})
              </Label>
            </div>
          </RadioGroup>
        </div>

        {/* Format Selection */}
        <div className="space-y-3">
          <Label>Export format</Label>
          <RadioGroup value={format} onValueChange={(v: "csv" | "json") => setFormat(v)}>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="csv" id="csv" />
              <Label htmlFor="csv" className="font-normal cursor-pointer flex items-center gap-2">
                <FileSpreadsheet className="h-4 w-4" />
                CSV (Excel, Google Sheets)
              </Label>
            </div>
            <div className="flex items-center space-x-2">
              <RadioGroupItem value="json" id="json" />
              <Label htmlFor="json" className="font-normal cursor-pointer flex items-center gap-2">
                <FileJson className="h-4 w-4" />
                JSON (Developer tools)
              </Label>
            </div>
          </RadioGroup>
        </div>

        {/* Field Selection */}
        <div className="space-y-3">
          <Label>Fields to include</Label>
          <div className="grid grid-cols-2 gap-2 max-h-48 overflow-y-auto p-1">
            {EXPORT_FIELDS.map((field) => (
              <div key={field.key} className="flex items-center space-x-2">
                <Checkbox
                  id={field.key}
                  checked={selectedFields.includes(field.key)}
                  onCheckedChange={() => handleFieldToggle(field.key)}
                />
                <Label htmlFor={field.key} className="font-normal text-sm cursor-pointer">
                  {field.label}
                </Label>
              </div>
            ))}
          </div>
        </div>
      </div>
    </DetailSheet>
  );
}
