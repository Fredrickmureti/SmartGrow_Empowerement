import { format } from "date-fns";
import { useNavigate } from "react-router-dom";
import { VendorStatementData } from "@/hooks/useVendorStatements";
import { useCurrency } from "@/hooks/useCurrency";
import { useDocumentBranding } from "@/hooks/useDocumentBranding";
import { ClickableEntity } from "@/components/common/ClickableEntity";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { AGING_BUCKET_LABELS } from "@/services/finance/aging";

interface VendorStatementPreviewProps {
  data: VendorStatementData;
}

const ROUTE_MAP: Record<string, string> = {
  bill: "/purchases/bills",
  payment: "/purchases/bills", // bill payments navigate to bill detail
  vendor_credit_note: "/purchases/credit-notes",
};

export function VendorStatementPreview({ data }: VendorStatementPreviewProps) {
  const { formatCurrency } = useCurrency();
  // Branding sourced from the issuing business + branch — see StatementPreview.
  const { branding } = useDocumentBranding(
    (data as any).business_id ?? null,
    (data as any).branch_id ?? null,
  );
  const navigate = useNavigate();

  const totalDebit = data.transactions.reduce((s, t) => s + t.debit, 0);
  const totalCredit = data.transactions.reduce((s, t) => s + t.credit, 0);
  const agingTotal = data.agingBuckets.total;

  const handleNavigateToSource = (txn: VendorStatementData['transactions'][number]) => {
    if (!txn.sourceId) return;
    const basePath = ROUTE_MAP[txn.type];
    if (basePath) {
      navigate(`${basePath}?id=${txn.sourceId}`);
    }
  };

  const renderReference = (txn: VendorStatementData['transactions'][number]) => {
    if (txn.sourceId && txn.reference) {
      return (
        <ClickableEntity onClick={() => handleNavigateToSource(txn)}>
          {txn.reference}
        </ClickableEntity>
      );
    }
    return <span className="text-sm font-mono">{txn.reference || "—"}</span>;
  };

  const getBadgeColor = (type: string) => {
    if (type === "bill") return "border-blue-300 text-blue-700 dark:text-blue-400";
    if (type === "payment") return "border-green-300 text-green-700 dark:text-green-400";
    return "border-orange-300 text-orange-700 dark:text-orange-400";
  };

  const formatType = (type: string) => {
    if (type === "vendor_credit_note") return "Credit Note";
    return type.charAt(0).toUpperCase() + type.slice(1);
  };

  return (
    <div className="bg-background border rounded-lg shadow-sm print:shadow-none print:border-0 min-w-0">
      {/* Header */}
      <div className="p-4 sm:p-6 pb-3 sm:pb-4 flex flex-col sm:flex-row sm:justify-between sm:items-start gap-3 sm:gap-4">
        <div className="flex items-start gap-3 sm:gap-4 min-w-0">
          {branding?.logo_url && (
            <img src={branding.logo_url} alt={branding.name} className="h-10 w-10 sm:h-14 sm:w-14 rounded object-contain shrink-0" />
          )}
          <div className="min-w-0">
            <h2 className="text-base sm:text-xl font-bold text-foreground truncate">{branding?.legal_name || branding?.name || "Company"}</h2>
            {branding?.address && <p className="text-xs sm:text-sm text-muted-foreground truncate">{branding.address}</p>}
            {(branding?.city || branding?.state || branding?.postal_code) && (
              <p className="text-xs sm:text-sm text-muted-foreground truncate">
                {[branding.city, branding.state, branding.postal_code].filter(Boolean).join(", ")}
              </p>
            )}
            {branding?.country && <p className="text-xs sm:text-sm text-muted-foreground">{branding.country}</p>}
          </div>
        </div>
        <div className="text-left sm:text-right shrink-0">
          <h1 className="text-lg sm:text-2xl font-bold tracking-tight text-primary uppercase">Vendor Statement</h1>
          <p className="text-xs sm:text-sm text-muted-foreground mt-0.5 sm:mt-1">Date: {format(new Date(), "MMM d, yyyy")}</p>
        </div>
      </div>

      <Separator />

      {/* Vendor + Period info */}
      <div className="p-4 sm:p-6 py-3 sm:py-4 grid grid-cols-1 sm:grid-cols-2 gap-4 sm:gap-6">
        <div className="min-w-0">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Vendor</p>
          <p className="font-semibold text-foreground text-sm sm:text-base truncate">{data.contact.name}</p>
          {data.contact.company && data.contact.company !== data.contact.name && (
            <p className="text-xs sm:text-sm text-muted-foreground truncate">{data.contact.company}</p>
          )}
          {data.contact.tax_id && (
            <p className="text-xs sm:text-sm text-muted-foreground font-mono truncate">Tax ID: {data.contact.tax_id}</p>
          )}
          {data.contact.address_line1 && <p className="text-xs sm:text-sm text-muted-foreground truncate">{data.contact.address_line1}</p>}
          {(data.contact.city || data.contact.state) && (
            <p className="text-xs sm:text-sm text-muted-foreground truncate">
              {[data.contact.city, data.contact.state, data.contact.postal_code].filter(Boolean).join(", ")}
            </p>
          )}
          {data.contact.country && <p className="text-xs sm:text-sm text-muted-foreground">{data.contact.country}</p>}
          {data.contact.email && <p className="text-xs sm:text-sm text-muted-foreground mt-1 truncate">{data.contact.email}</p>}
        </div>
        <div className="sm:text-right">
          <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-1">Statement Period</p>
          <p className="font-medium text-foreground text-sm sm:text-base">
            {format(new Date(data.periodStart), "MMM d, yyyy")} — {format(new Date(data.periodEnd), "MMM d, yyyy")}
          </p>
          <div className="mt-3 sm:mt-4 inline-block rounded-md border border-primary/30 bg-primary/5 px-3 sm:px-4 py-2">
            <p className="text-xs text-muted-foreground">Amount Owed</p>
            <p className={`text-lg sm:text-xl font-bold ${data.closingBalance > 0 ? "text-destructive" : "text-green-600"}`}>
              {formatCurrency(data.closingBalance)}
            </p>
          </div>
        </div>
      </div>

      <Separator />

      {/* Transactions */}
      <div className="p-4 sm:px-6 sm:py-4">
        {/* Desktop table */}
        <div className="hidden sm:block">
          <Table>
            <TableHeader>
              <TableRow className="hover:bg-transparent">
                <TableHead className="w-[100px]">Date</TableHead>
                <TableHead className="w-[90px]">Type</TableHead>
                <TableHead className="w-[120px]">Reference</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="text-right w-[100px]">Charges</TableHead>
                <TableHead className="text-right w-[100px]">Credits</TableHead>
                <TableHead className="text-right w-[110px]">Balance</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              <TableRow className="bg-muted/40 hover:bg-muted/40 font-medium">
                <TableCell colSpan={4} className="text-sm">Opening Balance</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right">—</TableCell>
                <TableCell className="text-right font-semibold">{formatCurrency(data.openingBalance)}</TableCell>
              </TableRow>
              {data.transactions.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={7} className="text-center text-muted-foreground py-8">No transactions in this period</TableCell>
                </TableRow>
              ) : (
                data.transactions.map((txn, i) => (
                  <TableRow key={i}>
                    <TableCell className="text-sm">{format(new Date(txn.date), "MMM d, yyyy")}</TableCell>
                    <TableCell>
                      <Badge variant="outline" className={`capitalize text-xs ${getBadgeColor(txn.type)}`}>
                        {formatType(txn.type)}
                      </Badge>
                    </TableCell>
                    <TableCell>{renderReference(txn)}</TableCell>
                    <TableCell className="text-sm">{txn.description}</TableCell>
                    <TableCell className="text-right text-sm">{txn.debit > 0 ? formatCurrency(txn.debit) : "—"}</TableCell>
                    <TableCell className="text-right text-sm">{txn.credit > 0 ? formatCurrency(txn.credit) : "—"}</TableCell>
                    <TableCell className="text-right text-sm font-medium">{formatCurrency(txn.balance)}</TableCell>
                  </TableRow>
                ))
              )}
              <TableRow className="border-t-2 hover:bg-transparent">
                <TableCell colSpan={4} className="font-semibold text-sm">Totals</TableCell>
                <TableCell className="text-right font-semibold text-sm">{formatCurrency(totalDebit)}</TableCell>
                <TableCell className="text-right font-semibold text-sm">{formatCurrency(totalCredit)}</TableCell>
                <TableCell className="text-right font-bold text-sm">{formatCurrency(data.closingBalance)}</TableCell>
              </TableRow>
            </TableBody>
          </Table>
        </div>

        {/* Mobile card list */}
        <div className="sm:hidden space-y-2">
          <div className="rounded-md bg-muted/40 p-3">
            <p className="text-xs text-muted-foreground">Opening Balance</p>
            <p className="text-sm font-semibold">{formatCurrency(data.openingBalance)}</p>
          </div>
          {data.transactions.length === 0 ? (
            <p className="text-center text-muted-foreground py-6 text-sm">No transactions in this period</p>
          ) : (
            data.transactions.map((txn, i) => (
              <div key={i} className="rounded-md border p-3 space-y-1.5">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-xs text-muted-foreground">{format(new Date(txn.date), "MMM d, yyyy")}</span>
                  <Badge variant="outline" className={`capitalize text-[10px] ${getBadgeColor(txn.type)}`}>
                    {formatType(txn.type)}
                  </Badge>
                </div>
                <p className="text-sm font-medium truncate">{txn.description}</p>
                {txn.reference && <div className="text-xs font-mono text-muted-foreground">{renderReference(txn)}</div>}
                <div className="flex items-center justify-between pt-1 border-t border-border/50">
                  <div className="flex gap-3">
                    {txn.debit > 0 && <span className="text-xs"><span className="text-muted-foreground">Charge: </span><span className="font-medium">{formatCurrency(txn.debit)}</span></span>}
                    {txn.credit > 0 && <span className="text-xs"><span className="text-muted-foreground">Credit: </span><span className="font-medium">{formatCurrency(txn.credit)}</span></span>}
                  </div>
                  <span className="text-xs font-semibold">{formatCurrency(txn.balance)}</span>
                </div>
              </div>
            ))
          )}
          <div className="rounded-md border-2 p-3 flex items-center justify-between">
            <span className="text-sm font-semibold">Totals</span>
            <div className="text-right text-xs space-y-0.5">
              <p><span className="text-muted-foreground">Charges:</span> <span className="font-semibold">{formatCurrency(totalDebit)}</span></p>
              <p><span className="text-muted-foreground">Credits:</span> <span className="font-semibold">{formatCurrency(totalCredit)}</span></p>
              <p className="font-bold text-sm">{formatCurrency(data.closingBalance)}</p>
            </div>
          </div>
        </div>
      </div>

      <Separator />

      {/* Aging Summary */}
      <div className="p-4 sm:px-6 sm:py-4">
        <p className="text-xs font-semibold text-muted-foreground uppercase tracking-wider mb-2 sm:mb-3">AP Aging Summary</p>
        <div className="hidden sm:block rounded-md border overflow-hidden">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-muted/50">
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">{AGING_BUCKET_LABELS.not_due}</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">{AGING_BUCKET_LABELS.current}</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">{AGING_BUCKET_LABELS.days30}</th>
                <th className="px-4 py-2 text-left font-medium text-muted-foreground">{AGING_BUCKET_LABELS.days60}</th>
                <th className="px-4 py-2 text-left font-medium text-destructive">{AGING_BUCKET_LABELS.days90}</th>
                <th className="px-4 py-2 text-right font-semibold">Total</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td className="px-4 py-2 font-medium">{formatCurrency(data.agingBuckets.not_due)}</td>
                <td className={`px-4 py-2 font-medium ${data.agingBuckets.current > 0 ? "text-amber-600" : ""}`}>{formatCurrency(data.agingBuckets.current)}</td>
                <td className={`px-4 py-2 font-medium ${data.agingBuckets.days30 > 0 ? "text-orange-600" : ""}`}>{formatCurrency(data.agingBuckets.days30)}</td>
                <td className={`px-4 py-2 font-medium ${data.agingBuckets.days60 > 0 ? "text-red-500" : ""}`}>{formatCurrency(data.agingBuckets.days60)}</td>
                <td className={`px-4 py-2 font-medium ${data.agingBuckets.days90 > 0 ? "text-destructive font-bold" : ""}`}>{formatCurrency(data.agingBuckets.days90)}</td>
                <td className="px-4 py-2 text-right font-bold">{formatCurrency(agingTotal)}</td>
              </tr>
            </tbody>
          </table>
        </div>
        {(data.agingBuckets.unconvertible_document_count || 0) > 0 && (
          <p className="mt-2 text-xs text-destructive">
            {data.agingBuckets.unconvertible_document_count} open document(s) are in a currency with no
            exchange rate on file and are excluded from this aging summary.
          </p>
        )}
        <div className="sm:hidden grid grid-cols-2 gap-2">
          {[
            { label: AGING_BUCKET_LABELS.not_due, value: data.agingBuckets.not_due, color: "" },
            { label: AGING_BUCKET_LABELS.current, value: data.agingBuckets.current, color: data.agingBuckets.current > 0 ? "text-amber-600" : "" },
            { label: AGING_BUCKET_LABELS.days30, value: data.agingBuckets.days30, color: data.agingBuckets.days30 > 0 ? "text-orange-600" : "" },
            { label: AGING_BUCKET_LABELS.days60, value: data.agingBuckets.days60, color: data.agingBuckets.days60 > 0 ? "text-red-500" : "" },
            { label: AGING_BUCKET_LABELS.days90, value: data.agingBuckets.days90, color: data.agingBuckets.days90 > 0 ? "text-destructive" : "" },
            { label: "Total", value: agingTotal, color: "font-bold" },
          ].map((bucket) => (
            <div key={bucket.label} className="rounded-md border p-2">
              <p className="text-[10px] text-muted-foreground uppercase">{bucket.label}</p>
              <p className={`text-sm font-medium ${bucket.color}`}>{formatCurrency(bucket.value)}</p>
            </div>
          ))}
        </div>

      </div>

      {/* Footer */}
      <div className="px-4 sm:px-6 py-4 sm:py-5 bg-muted/30 border-t flex flex-col sm:flex-row sm:justify-between sm:items-center gap-3">
        <div className="text-xs sm:text-sm text-muted-foreground">
          <p>This statement reflects all bills, payments, and credits for the period shown.</p>
          <p>Questions? Contact us at {branding?.email || branding?.phone || "our office"}.</p>
        </div>
        <div className="sm:text-right shrink-0">
          <p className="text-xs text-muted-foreground uppercase tracking-wider">Total Amount Owed</p>
          <p className={`text-xl sm:text-2xl font-bold ${data.closingBalance > 0 ? "text-destructive" : "text-green-600"}`}>
            {formatCurrency(data.closingBalance)}
          </p>
        </div>
      </div>
    </div>
  );
}
