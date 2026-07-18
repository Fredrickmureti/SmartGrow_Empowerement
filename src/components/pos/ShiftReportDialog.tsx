import { useState, useRef, useEffect } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { usePOSReports, ShiftReport } from "@/hooks/pos/usePOSReports";
import { useCurrency } from "@/hooks/useCurrency";
import { format } from "date-fns";
import { Printer, FileText, TrendingUp, DollarSign, CreditCard, Banknote, Loader2, RefreshCw, AlertTriangle, CheckCircle } from "lucide-react";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";
import { normalizeError } from "@/services/resilience";

interface ShiftReportDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  shiftId: string;
  registerId: string;
  isXReport?: boolean;
  glPostedAt?: string | null;
  shiftStatus?: string;
}

export function ShiftReportDialog({
  open,
  onOpenChange,
  shiftId,
  registerId,
  isXReport = true,
  glPostedAt,
  shiftStatus,
}: ShiftReportDialogProps) {
  const { getShiftReport, topProducts, isTopProductsLoading } = usePOSReports();
  const { formatCurrency } = useCurrency();
  const [shiftReport, setShiftReport] = useState<ShiftReport | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const reportRef = useRef<HTMLDivElement>(null);
  const [isRetryingGL, setIsRetryingGL] = useState(false);
  const [localGlPostedAt, setLocalGlPostedAt] = useState(glPostedAt);
  
  // Print preview state
  const [printPreviewOpen, setPrintPreviewOpen] = useState(false);
  const [printPreviewHtml, setPrintPreviewHtml] = useState("");

  useEffect(() => {
    if (open && shiftId) {
      setIsLoading(true);
      getShiftReport(shiftId)
        .then(setShiftReport)
        .finally(() => setIsLoading(false));
    }
  }, [open, shiftId, getShiftReport]);

  const handlePrint = () => {
    if (!reportRef.current || !shiftReport) return;
    
    const report = shiftReport;
    const html = `
      <!DOCTYPE html>
      <html>
      <head>
        <title>Shift Report</title>
        <style>
          body { font-family: system-ui, sans-serif; padding: 20px; }
          .header { text-align: center; margin-bottom: 20px; }
          .section { margin: 15px 0; padding: 10px; border: 1px solid #e5e7eb; border-radius: 8px; }
          .row { display: flex; justify-content: space-between; padding: 5px 0; }
          .label { color: #6b7280; }
          .value { font-weight: 500; }
          .separator { border-top: 1px solid #e5e7eb; margin: 10px 0; }
          .total { font-weight: bold; font-size: 1.1em; }
        </style>
      </head>
      <body>
        <div class="header">
          <h2>${isXReport ? "X Report (Shift Summary)" : "Z Report (Shift Closing)"}</h2>
          <p>${report.shift.shift_number} • ${format(new Date(report.shift.opened_at), "MMM d, yyyy h:mm a")}</p>
        </div>
        
        <div class="section">
          <h3>Sales Summary</h3>
          <div class="row"><span class="label">Total Sales</span><span class="value">${formatCurrency(report.sales.total)}</span></div>
          <div class="row"><span class="label">Transactions</span><span class="value">${report.sales.count}</span></div>
          <div class="row"><span class="label">Refunds</span><span class="value">-${formatCurrency(report.sales.returns)}</span></div>
          <div class="separator"></div>
          <div class="row total"><span>Net Sales</span><span>${formatCurrency(report.sales.net)}</span></div>
        </div>
        
        <div class="section">
          <h3>Cash Drawer</h3>
          <div class="row"><span class="label">Opening Float</span><span class="value">${formatCurrency(report.shift.opening_cash)}</span></div>
          <div class="row"><span class="label">Cash Sales</span><span class="value">+${formatCurrency(report.sales.byPaymentMethod.cash || 0)}</span></div>
          <div class="row"><span class="label">Cash In</span><span class="value">+${formatCurrency(report.cashMovements.cashIn)}</span></div>
          <div class="row"><span class="label">Cash Out</span><span class="value">-${formatCurrency(report.cashMovements.cashOut)}</span></div>
          <div class="separator"></div>
          <div class="row total"><span>Expected Cash</span><span>${formatCurrency(report.shift.expected_cash)}</span></div>
        </div>
        
        <div class="section">
          <h3>Payment Methods</h3>
          ${Object.entries(report.sales.byPaymentMethod).map(([method, amount]) => 
            `<div class="row"><span class="label">${method.replace("_", " ")}</span><span class="value">${formatCurrency(amount)}</span></div>`
          ).join('')}
        </div>
        
        <p style="text-align: center; color: #9ca3af; margin-top: 30px;">
          Printed on ${format(new Date(), "MMM d, yyyy h:mm a")}
        </p>
      </body>
      </html>
    `;
    
    setPrintPreviewHtml(html);
    setPrintPreviewOpen(true);
  };

  if (isLoading || !shiftReport) {
    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-w-2xl">
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-8 w-8 animate-spin text-primary" />
          </div>
        </DialogContent>
      </Dialog>
    );
  }

  const report = shiftReport;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh]">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <FileText className="h-5 w-5" />
            {isXReport ? "X Report (Shift Summary)" : "Z Report (Shift Closing)"}
          </DialogTitle>
          <DialogDescription>
            {report.shift.shift_number} • {format(new Date(report.shift.opened_at), "MMM d, yyyy h:mm a")}
          </DialogDescription>
        </DialogHeader>

        <ScrollArea className="max-h-[60vh]">
          <div ref={reportRef} className="space-y-6 pr-4">
            <Tabs defaultValue="summary">
              <TabsList className="grid w-full grid-cols-3">
                <TabsTrigger value="summary">Summary</TabsTrigger>
                <TabsTrigger value="payments">Payments</TabsTrigger>
                <TabsTrigger value="products">Top Products</TabsTrigger>
              </TabsList>

              <TabsContent value="summary" className="space-y-4 mt-4">
                {/* Key Metrics */}
                <div className="grid grid-cols-2 gap-4">
                  <div className="p-4 rounded-lg border bg-card">
                    <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                      <DollarSign className="h-4 w-4" />
                      Total Sales
                    </div>
                    <p className="text-2xl font-bold">{formatCurrency(report.sales.total)}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      {report.sales.count} transactions
                    </p>
                  </div>
                  <div className="p-4 rounded-lg border bg-card">
                    <div className="flex items-center gap-2 text-muted-foreground text-sm mb-1">
                      <TrendingUp className="h-4 w-4" />
                      Net Sales
                    </div>
                    <p className="text-2xl font-bold">{formatCurrency(report.sales.net)}</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      After {report.sales.returnsCount} refunds
                    </p>
                  </div>
                </div>

                {/* Sales Breakdown */}
                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="font-semibold">Sales Breakdown</h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Gross Sales</span>
                      <span>{formatCurrency(report.sales.total)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Refunds</span>
                      <span className="text-red-600">-{formatCurrency(report.sales.returns)}</span>
                    </div>
                    <Separator />
                    <div className="flex justify-between font-semibold">
                      <span>Net Sales</span>
                      <span>{formatCurrency(report.sales.net)}</span>
                    </div>
                  </div>
                </div>

                {/* Cash Drawer */}
                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="font-semibold flex items-center gap-2">
                    <Banknote className="h-4 w-4" />
                    Cash Drawer
                  </h4>
                  <div className="space-y-2 text-sm">
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Opening Float</span>
                      <span>{formatCurrency(report.shift.opening_cash)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cash Sales</span>
                      <span className="text-green-600">+{formatCurrency(report.sales.byPaymentMethod.cash || 0)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cash In</span>
                      <span className="text-green-600">+{formatCurrency(report.cashMovements.cashIn)}</span>
                    </div>
                    <div className="flex justify-between">
                      <span className="text-muted-foreground">Cash Out</span>
                      <span className="text-red-600">-{formatCurrency(report.cashMovements.cashOut)}</span>
                    </div>
                    <Separator />
                    <div className="flex justify-between font-bold">
                      <span>Expected Cash</span>
                      <span>{formatCurrency(report.shift.expected_cash)}</span>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="payments" className="space-y-4 mt-4">
                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="font-semibold flex items-center gap-2">
                    <CreditCard className="h-4 w-4" />
                    Payment Methods
                  </h4>
                  <div className="space-y-3">
                    {Object.entries(report.sales.byPaymentMethod).map(([method, amount]) => (
                      <div key={method} className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          {method === "cash" ? (
                            <Banknote className="h-4 w-4 text-green-600" />
                          ) : (
                            <CreditCard className="h-4 w-4 text-blue-600" />
                          )}
                          <span className="capitalize">{method.replace("_", " ")}</span>
                        </div>
                        <div className="text-right">
                          <p className="font-semibold">{formatCurrency(amount)}</p>
                          <p className="text-xs text-muted-foreground">
                            {report.sales.total > 0 
                              ? Math.round((amount / report.sales.total) * 100) 
                              : 0}%
                          </p>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>

                <div className="border rounded-lg p-4 space-y-3">
                  <h4 className="font-semibold">Transaction Stats</h4>
                  <div className="grid grid-cols-2 gap-4 text-sm">
                    <div>
                      <p className="text-muted-foreground">Total Transactions</p>
                      <p className="text-lg font-semibold">{report.sales.count}</p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Average Sale</p>
                      <p className="text-lg font-semibold">
                        {report.sales.count > 0 ? formatCurrency(report.sales.total / report.sales.count) : formatCurrency(0)}
                      </p>
                    </div>
                    <div>
                      <p className="text-muted-foreground">Refunds</p>
                      <p className="text-lg font-semibold">{report.sales.returnsCount}</p>
                    </div>
                  </div>
                </div>
              </TabsContent>

              <TabsContent value="products" className="space-y-4 mt-4">
                <div className="border rounded-lg p-4">
                  <h4 className="font-semibold mb-4">Top Selling Products</h4>
                  {isTopProductsLoading ? (
                    <div className="flex justify-center py-4">
                      <Loader2 className="h-6 w-6 animate-spin text-primary" />
                    </div>
                  ) : report.products.length === 0 ? (
                    <p className="text-center text-muted-foreground py-4">No sales data yet</p>
                  ) : (
                    <div className="space-y-3">
                      {report.products.slice(0, 10).map((product, index) => (
                        <div key={product.name} className="flex items-center justify-between">
                          <div className="flex items-center gap-3">
                            <span className="text-muted-foreground w-6">{index + 1}.</span>
                            <div>
                              <p className="font-medium">{product.name}</p>
                              <p className="text-xs text-muted-foreground">
                                {product.quantity} units sold
                              </p>
                            </div>
                          </div>
                          <p className="font-semibold">{formatCurrency(product.revenue)}</p>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </TabsContent>
            </Tabs>
          </div>
        </ScrollArea>

        {/*
          Phase 4: shift-level "GL posted" status was tied to the
          aggregating post_pos_shift_gl, which has been dropped. GL is
          now posted per-transaction (post_pos_sale_gl) and per-close
          for cash variance (trg_pos_close_variance_gl). There is no
          single shift-level JE to badge; each sale and the variance
          entry each have their own journal_entries row visible from
          Finance → Journal.
        */}
        {shiftStatus === "closed" && localGlPostedAt && (
          <div className="flex items-center gap-2 px-3 py-2 rounded-lg text-sm bg-green-500/10 text-green-700 dark:text-green-400">
            <CheckCircle className="h-4 w-4 shrink-0" />
            <span>Cash variance posted {format(new Date(localGlPostedAt), "MMM d, h:mm a")}</span>
          </div>
        )}

        <div className="flex justify-end gap-2 pt-2">
          <Button variant="outline" onClick={handlePrint}>
            <Printer className="h-4 w-4 mr-2" />
            Print
          </Button>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </div>

        <PrintPreviewDialog
          open={printPreviewOpen}
          onOpenChange={setPrintPreviewOpen}
          html={printPreviewHtml}
          title={isXReport ? "X Report" : "Z Report"}
          filename={`shift-report-${shiftReport?.shift.shift_number || 'unknown'}`}
        />
      </DialogContent>
    </Dialog>
  );
}
