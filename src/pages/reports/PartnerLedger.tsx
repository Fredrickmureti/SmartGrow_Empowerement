/**
 * Partner Ledger Page
 * 
 * Shows all transactions by customer or vendor with opening/closing balances.
 */

import { useState, useCallback } from "react";
import { DrillDownDialog, DrillDownConfig } from "@/components/reports/DrillDownDialog";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { ChevronDown, ChevronRight } from "lucide-react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { ReportPageLayout } from "@/components/reports/ReportPageLayout";
import { RefreshButton } from "@/components/ui/RefreshButton";
import { ReportFilters } from "@/components/reports/ReportFilters";
import { useReportFilters, ReportFilterProvider } from "@/contexts/ReportFilterContext";
import { ReportBranchFilter } from "@/components/reports/ReportBranchFilter";
import { SaveViewButton } from "@/components/reports/SaveViewButton";
import { format, startOfYear, endOfMonth } from "date-fns";
import type { ExportConfig, ExportRow } from "@/services/reports/ReportExportService";
import { Button } from "@/components/ui/button";
import { Banknote } from "lucide-react";
import { useCustomerUnappliedDeposits } from "@/hooks/useCustomerUnappliedDeposits";
import { ApplyCustomerDepositDialog } from "@/components/payments/ApplyCustomerDepositDialog";

import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";

/**
 * ADR 0012 R3 — per-customer "Apply Deposit" header action.
 * Only renders when the customer has cash sitting on Customer Deposits.
 * Reuses the same dialog the CustomerPayments page mounts.
 */
function PartnerLedgerDepositAction({
  contactId,
  partnerType,
}: {
  contactId: string;
  partnerType: "customer" | "supplier";
}) {
  const enabled = partnerType === "customer";
  const { totalUnapplied } = useCustomerUnappliedDeposits(enabled ? contactId : null);
  const { formatCurrency } = useCurrency();
  const [open, setOpen] = useState(false);
  if (!enabled || totalUnapplied <= 0) return null;
  return (
    <>
      <Button
        size="sm"
        variant="outline"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
      >
        <Banknote className="h-4 w-4 mr-1" />
        Apply {formatCurrency(totalUnapplied)}
      </Button>
      <ApplyCustomerDepositDialog
        open={open}
        onOpenChange={setOpen}
        contactId={contactId}
      />
    </>
  );
}
interface PartnerTransaction {
  id: string;
  entry_date: string;
  entry_number: string;
  description: string;
  debit: number;
  credit: number;
  running_balance: number;
}

interface PartnerData {
  contact_id: string;
  contact_name: string;
  opening_balance: number;
  transactions: PartnerTransaction[];
  closing_balance: number;
  total_debit: number;
  total_credit: number;
}

function PartnerLedgerInner() {
  const now = new Date();
  const { filters } = useReportFilters();
  const [partnerType, setPartnerType] = useState<"customer" | "supplier">("customer");
  const [dateFrom, setDateFrom] = useState(filters.dateFrom || format(startOfYear(now), "yyyy-MM-dd"));
  const [dateTo, setDateTo] = useState(filters.dateTo || format(endOfMonth(now), "yyyy-MM-dd"));
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [drillDown, setDrillDown] = useState<{ open: boolean; config: DrillDownConfig | null }>({ open: false, config: null });

  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { formatCurrency, baseCurrency, isReady: currencyReady } = useCurrency();

  const { data, isLoading, error } = useQuery({
    queryKey: ["partner-ledger", currentOrg?.id, currentBusiness?.id, filters.branchId, partnerType, dateFrom, dateTo],
    queryFn: async (): Promise<PartnerData[]> => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      // ADR 0029 — Single AR/AP balance engine.
      // Partner Ledger now reads the SAME canonical subledger views that
      // the Sales Customer Ledger and Vendor Ledger consume. The previous
      // implementation re-aggregated `journal_entry_lines` filtered by
      // `contact_id IS NOT NULL` with NO account_id filter, which
      // double-counted any JE leg stamped with a contact (Sales / Discount
      // / Tax / Customer-Deposit legs included). That produced balances
      // that diverged from the customer-facing report.
      const viewName =
        partnerType === "customer" ? "customer_ledger_entries" : "vendor_ledger_entries";

      const pageSize = 1000;
      const fetchAll = async (filterDate: { lt?: string; gte?: string; lte?: string }) => {
        const rows: any[] = [];
        let offset = 0;
        while (true) {
          let q = (supabase as any)
            .from(viewName)
            .select(
              "contact_id, entry_date, doc_type, doc_id, doc_ref, debit, credit, branch_id, business_id, organization_id, created_at",
            )
            .eq("organization_id", currentOrg.id)
            .eq("business_id", currentBusiness.id);
          if (filters.branchId) {
            q = q.or(`branch_id.eq.${filters.branchId},branch_id.is.null`);
          }
          if (filterDate.lt) q = q.lt("entry_date", filterDate.lt);
          if (filterDate.gte) q = q.gte("entry_date", filterDate.gte);
          if (filterDate.lte) q = q.lte("entry_date", filterDate.lte);
          q = q.order("entry_date", { ascending: true }).order("created_at", { ascending: true });
          const { data: page, error: err } = await q.range(offset, offset + pageSize - 1);
          if (err) throw err;
          rows.push(...(page || []));
          if (!page || page.length < pageSize) break;
          offset += pageSize;
        }
        return rows;
      };

      const [priorRows, periodRows] = await Promise.all([
        fetchAll({ lt: dateFrom }),
        fetchAll({ gte: dateFrom, lte: dateTo }),
      ]);

      // Resolve contact names in a single follow-up query.
      const contactIds = Array.from(
        new Set([...priorRows, ...periodRows].map((r) => r.contact_id).filter(Boolean)),
      );
      const nameById = new Map<string, string>();
      if (contactIds.length) {
        const { data: contacts } = await supabase
          .from("contacts")
          .select("id, name")
          .in("id", contactIds);
        for (const c of contacts || []) nameById.set(c.id, c.name);
      }

      // Opening balances from prior-period rows.
      const contactMap = new Map<string, PartnerData>();
      for (const row of priorRows) {
        const id = row.contact_id;
        if (!id) continue;
        const existing = contactMap.get(id) || {
          contact_id: id,
          contact_name: nameById.get(id) || "(unknown)",
          opening_balance: 0,
          transactions: [],
          closing_balance: 0,
          total_debit: 0,
          total_credit: 0,
        };
        existing.opening_balance += (Number(row.debit) || 0) - (Number(row.credit) || 0);
        contactMap.set(id, existing);
      }

      // Period transactions.
      for (const row of periodRows) {
        const id = row.contact_id;
        if (!id) continue;
        let partner = contactMap.get(id);
        if (!partner) {
          partner = {
            contact_id: id,
            contact_name: nameById.get(id) || "(unknown)",
            opening_balance: 0,
            transactions: [],
            closing_balance: 0,
            total_debit: 0,
            total_credit: 0,
          };
          contactMap.set(id, partner);
        }
        const debit = Number(row.debit) || 0;
        const credit = Number(row.credit) || 0;
        partner.transactions.push({
          id: `${row.doc_type}:${row.doc_id}`,
          entry_date: row.entry_date,
          entry_number: row.doc_ref || "",
          description: row.doc_type,
          debit,
          credit,
          running_balance: 0,
        });
        partner.total_debit += debit;
        partner.total_credit += credit;
      }

      // Running balances.
      const result = Array.from(contactMap.values());
      for (const partner of result) {
        partner.transactions.sort(
          (a, b) => new Date(a.entry_date).getTime() - new Date(b.entry_date).getTime(),
        );
        let balance = partner.opening_balance;
        for (const txn of partner.transactions) {
          balance += txn.debit - txn.credit;
          txn.running_balance = balance;
        }
        partner.closing_balance = balance;
      }

      return result.sort((a, b) => a.contact_name.localeCompare(b.contact_name));
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  const togglePartner = (id: string) => {
    const n = new Set(expanded);
    if (n.has(id)) n.delete(id); else n.add(id);
    setExpanded(n);
  };

  const getExportConfig = useCallback((): ExportConfig => {
    const rows: ExportRow[] = [];
    for (const p of data || []) {
      rows.push({ partner: p.contact_name, date: "", entry: "", desc: "", debit: null, credit: null, balance: null, _isHeader: true });
      for (const t of p.transactions) {
        rows.push({ partner: "", date: t.entry_date, entry: t.entry_number, desc: t.description, debit: t.debit || null, credit: t.credit || null, balance: t.running_balance });
      }
      rows.push({ partner: "", date: "", entry: "", desc: "Total", debit: p.total_debit, credit: p.total_credit, balance: p.closing_balance, _isSubtotal: true });
    }
    return {
      title: `${partnerType === "customer" ? "Customer" : "Supplier"} Ledger`,
      companyName: currentOrg?.name || "",
      organizationId: currentOrg?.id,
      dateRange: `${format(new Date(dateFrom), "MMM d, yyyy")} – ${format(new Date(dateTo), "MMM d, yyyy")}`,
      columns: [
        { key: "partner", header: "Partner", width: 20 },
        { key: "date", header: "Date", width: 12 },
        { key: "entry", header: "Entry #", width: 12 },
        { key: "desc", header: "Description", width: 25 },
        { key: "debit", header: "Debit", width: 16, format: "currency", align: "right" },
        { key: "credit", header: "Credit", width: 16, format: "currency", align: "right" },
        { key: "balance", header: "Balance", width: 16, format: "currency", align: "right" },
      ],
      rows,
      sheetName: "Partner Ledger",
    };
  }, [data, partnerType, dateFrom, dateTo, currentOrg]);

  return (
    <ReportPageLayout
      title="Partner Ledger"
      description="Transaction history by customer or supplier"
      isLoading={isLoading || !currencyReady}
      error={error as Error | null}
      isEmpty={!data || data.length === 0}
      emptyMessage={`No transactions found for ${partnerType}s`}
      getExportConfig={getExportConfig}
      headerActions={
        <>
          <RefreshButton queryKeyPrefixes={[['partner-ledger'] as const]} tooltip="Refresh partner ledger" />
          <SaveViewButton
            reportType="partner-ledger"
            currentFilters={{ partnerType, dateFrom, dateTo }}
            onLoadView={(filters) => {
              if (filters.partnerType) setPartnerType(filters.partnerType);
              if (filters.dateFrom) setDateFrom(filters.dateFrom);
              if (filters.dateTo) setDateTo(filters.dateTo);
            }}
          />
        </>
      }
      filters={
        <ReportFilters dateFrom={dateFrom} dateTo={dateTo} onDateFromChange={setDateFrom} onDateToChange={setDateTo}>
          <ReportBranchFilter reportKind="partner_ledger" />
          <Tabs value={partnerType} onValueChange={(v) => setPartnerType(v as "customer" | "supplier")}>
            <TabsList>
              <TabsTrigger value="customer">Customers</TabsTrigger>
              <TabsTrigger value="supplier">Suppliers</TabsTrigger>
            </TabsList>
          </Tabs>
        </ReportFilters>
      }
    >
      <div className="space-y-4">
        {data?.map((partner) => {
          const isOpen = expanded.has(partner.contact_id);
          return (
            <Card key={partner.contact_id}>
              <Collapsible open={isOpen} onOpenChange={() => togglePartner(partner.contact_id)}>
                <CollapsibleTrigger asChild>
                  <CardHeader className="cursor-pointer hover:bg-muted/50 transition-colors">
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        {isOpen ? <ChevronDown className="h-5 w-5 text-muted-foreground" /> : <ChevronRight className="h-5 w-5 text-muted-foreground" />}
                        <div>
                          <CardTitle className="text-base">{partner.contact_name}</CardTitle>
                          <CardDescription>{partner.transactions.length} transactions</CardDescription>
                        </div>
                      </div>
                      <div className="flex items-center gap-3">
                        <PartnerLedgerDepositAction
                          contactId={partner.contact_id}
                          partnerType={partnerType}
                        />
                        <div className="text-right">
                          <p className="text-sm text-muted-foreground">Balance</p>
                          <p className="font-bold">{formatCurrency(partner.closing_balance, baseCurrency)}</p>
                        </div>
                      </div>
                    </div>
                  </CardHeader>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <CardContent>
                    <Table>
                      <TableHeader>
                        <TableRow>
                          <TableHead>Date</TableHead>
                          <TableHead>Entry #</TableHead>
                          <TableHead>Description</TableHead>
                          <TableHead className="text-right">Debit</TableHead>
                          <TableHead className="text-right">Credit</TableHead>
                          <TableHead className="text-right">Balance</TableHead>
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {partner.transactions.map((txn) => (
                          <TableRow key={txn.id}>
                            <TableCell>{format(new Date(txn.entry_date), "MMM d, yyyy")}</TableCell>
                            <TableCell className="font-mono text-sm">{txn.entry_number}</TableCell>
                            <TableCell>{txn.description}</TableCell>
                            <TableCell className="text-right">{txn.debit > 0 ? (
                              <button className="hover:underline hover:text-primary cursor-pointer" onClick={() => setDrillDown({ open: true, config: { title: `${partner.contact_name} — Debit`, startDate: txn.entry_date, endDate: txn.entry_date } })}>{formatCurrency(txn.debit, baseCurrency)}</button>
                            ) : "—"}</TableCell>
                            <TableCell className="text-right">{txn.credit > 0 ? (
                              <button className="hover:underline hover:text-primary cursor-pointer" onClick={() => setDrillDown({ open: true, config: { title: `${partner.contact_name} — Credit`, startDate: txn.entry_date, endDate: txn.entry_date } })}>{formatCurrency(txn.credit, baseCurrency)}</button>
                            ) : "—"}</TableCell>
                            <TableCell className="text-right font-medium">{formatCurrency(txn.running_balance, baseCurrency)}</TableCell>
                          </TableRow>
                        ))}
                        <TableRow className="bg-muted/30 font-medium">
                          <TableCell colSpan={3}>Total</TableCell>
                          <TableCell className="text-right">{formatCurrency(partner.total_debit, baseCurrency)}</TableCell>
                          <TableCell className="text-right">{formatCurrency(partner.total_credit, baseCurrency)}</TableCell>
                          <TableCell className="text-right font-bold">{formatCurrency(partner.closing_balance, baseCurrency)}</TableCell>
                        </TableRow>
                      </TableBody>
                    </Table>
                  </CardContent>
                </CollapsibleContent>
              </Collapsible>
            </Card>
          );
        })}
      </div>
      <DrillDownDialog
        open={drillDown.open}
        onOpenChange={(open) => setDrillDown((prev) => ({ ...prev, open }))}
        config={drillDown.config}
      />
    </ReportPageLayout>
  );
}


export default function PartnerLedger() {
  return (
    
    <ReportFilterProvider>
      <CompanyScopeGate reportName="Partner Ledger">
      <PartnerLedgerInner />
    </CompanyScopeGate>
    </ReportFilterProvider>
  );
}
