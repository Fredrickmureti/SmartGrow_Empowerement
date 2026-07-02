import { useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Checkbox } from "@/components/ui/checkbox";
import { Download, FileSpreadsheet, FileJson } from "lucide-react";
import { Invoice } from "@/hooks/useInvoices";
import { useExport } from "@/hooks/useExport";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface BulkExportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  selectedInvoices: Invoice[];
  allInvoices: Invoice[];
}

const EXPORT_FIELDS = [
  { key: "invoice_number", label: "Invoice Number", default: true },
  { key: "customer", label: "Customer", default: true },
  { key: "issue_date", label: "Issue Date", default: true },
  { key: "due_date", label: "Due Date", default: true },
  { key: "status", label: "Status", default: true },
  { key: "subtotal", label: "Subtotal", default: true },
  { key: "tax_amount", label: "Tax Amount", default: true },
  { key: "total", label: "Total", default: true },
  { key: "amount_paid", label: "Amount Paid", default: true },
  { key: "balance", label: "Balance Due", default: true },
  { key: "currency", label: "Currency", default: true },
  { key: "notes", label: "Notes", default: false },
  { key: "terms", label: "Terms", default: false },
];

export function BulkExportDialog({
  open,
  onOpenChange,
  selectedInvoices,
  allInvoices,
}: BulkExportDialogProps) {
  const [format, setFormat] = useState<"csv" | "json">("csv");
  const [exportScope, setExportScope] = useState<"selected" | "all">("selected");
  const [selectedFields, setSelectedFields] = useState<string[]>(
    EXPORT_FIELDS.filter((f) => f.default).map((f) => f.key)
  );
  const { exportToCSV, exportToJSON } = useExport();
  const { toast } = useToast();

  const invoicesToExport = exportScope === "selected" ? selectedInvoices : allInvoices;

  const handleFieldToggle = (key: string) => {
    setSelectedFields((prev) =>
      prev.includes(key) ? prev.filter((f) => f !== key) : [...prev, key]
    );
  };

  const handleExport = () => {
    if (invoicesToExport.length === 0) {
      toast({
        title: "No invoices to export",
        description: "Please select at least one invoice to export.",
        variant: "destructive",
      });
      return;
    }

    const data = invoicesToExport.map((inv) => {
      const row: Record<string, any> = {};
      if (selectedFields.includes("invoice_number")) row.invoice_number = inv.invoice_number;
      if (selectedFields.includes("customer")) row.customer = inv.contact?.name || "";
      if (selectedFields.includes("issue_date")) row.issue_date = inv.issue_date;
      if (selectedFields.includes("due_date")) row.due_date = inv.due_date;
      if (selectedFields.includes("status")) row.status = inv.status;
      if (selectedFields.includes("subtotal")) row.subtotal = inv.subtotal;
      if (selectedFields.includes("tax_amount")) row.tax_amount = inv.tax_amount;
      if (selectedFields.includes("total")) row.total = inv.total;
      if (selectedFields.includes("amount_paid")) row.amount_paid = inv.amount_paid || 0;
      if (selectedFields.includes("balance")) row.balance = inv.total - (inv.amount_paid || 0);
      if (selectedFields.includes("currency")) row.currency = inv.currency;
      if (selectedFields.includes("notes")) row.notes = inv.notes || "";
      if (selectedFields.includes("terms")) row.terms = inv.terms || "";
      return row;
    });

    const filename = `invoices_${new Date().toISOString().split("T")[0]}`;

    try {
      if (format === "csv") {
        exportToCSV(data, { filename, headers: selectedFields });
      } else {
        exportToJSON(data, { filename });
      }
      toast({
        title: "Export successful",
        description: `Exported ${invoicesToExport.length} invoices as ${format.toUpperCase()}.`,
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
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="h-5 w-5" />
            Export Invoices
          </DialogTitle>
          <DialogDescription>
            Export invoices to CSV or JSON format for use in other applications.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-6">
          {/* Export Scope */}
          <div className="space-y-3">
            <Label>What to export</Label>
            <RadioGroup value={exportScope} onValueChange={(v: "selected" | "all") => setExportScope(v)}>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="selected" id="selected" />
                <Label htmlFor="selected" className="font-normal cursor-pointer">
                  Selected invoices ({selectedInvoices.length})
                </Label>
              </div>
              <div className="flex items-center space-x-2">
                <RadioGroupItem value="all" id="all" />
                <Label htmlFor="all" className="font-normal cursor-pointer">
                  All invoices ({allInvoices.length})
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

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleExport} disabled={selectedFields.length === 0}>
            <Download className="mr-2 h-4 w-4" />
            Export {invoicesToExport.length} Invoice{invoicesToExport.length !== 1 ? "s" : ""}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
