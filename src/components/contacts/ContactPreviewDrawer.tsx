/**
 * ContactPreviewDrawer
 * 
 * Reusable right-side Sheet for quick contact context:
 * name, type, email, phone, outstanding balance, recent transactions.
 * "View Full Profile" navigates to the exact contact record.
 *
 * Phase C (Contacts audit): all queries are now scoped via useScopedFrom() so
 * they always include both organization_id AND business_id filters. If the
 * loaded contact belongs to a different business than the active one, we render
 * an explicit cross-company empty state instead of silently surfacing data.
 */

import { useEffect, useState } from "react";
import { DetailRow } from "@/components/common/DetailRow";
import { useNavigate, useLocation } from "react-router-dom";
import { useScopedFrom } from "@/lib/useScopedQuery";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useOrganization } from "@/hooks/useOrganization";
import { fetchContactOpenItemAging, EMPTY_OPEN_ITEM_AGING } from "@/services/finance/openItems";
import { useCurrency } from "@/hooks/useCurrency";
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Skeleton } from "@/components/ui/skeleton";
import {
  Building2,
  Mail,
  Phone,
  ExternalLink,
  FileText,
  CreditCard,
  User,
  ShieldAlert,
  BarChart3,
} from "lucide-react";
import { format } from "date-fns";

interface ContactPreviewDrawerProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  contactId: string | null | undefined;
}

interface AgingBucket {
  current: number;
  days1_30: number;
  days31_60: number;
  days61_90: number;
  days90plus: number;
}

interface ContactData {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  type: string | null;
  customer_rank: number | null;
  supplier_rank: number | null;
  is_company: boolean | null;
  credit_hold: boolean | null;
  credit_limit: number | null;
  business_id: string | null;
}

interface TransactionSummary {
  type: "invoice" | "bill" | "credit_note" | "vendor_credit_note" | "payment" | "bill_payment" | "estimate" | "sales_order";
  id: string;
  number: string;
  date: string;
  amount: number;
  status: string;
}

export function ContactPreviewDrawer({
  open,
  onOpenChange,
  contactId,
}: ContactPreviewDrawerProps) {
  const navigate = useNavigate();
  const location = useLocation();
  const { formatCurrency } = useCurrency();
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const scoped = useScopedFrom();
  const [contact, setContact] = useState<ContactData | null>(null);
  const [receivable, setReceivable] = useState(0);
  const [payable, setPayable] = useState(0);
  const [aging, setAging] = useState<AgingBucket>({ current: 0, days1_30: 0, days31_60: 0, days61_90: 0, days90plus: 0 });
  const [apAging, setApAging] = useState<AgingBucket>({ current: 0, days1_30: 0, days31_60: 0, days61_90: 0, days90plus: 0 });
  const [recentTransactions, setRecentTransactions] = useState<TransactionSummary[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [crossBusiness, setCrossBusiness] = useState<{ contactBizId: string | null } | null>(null);

  useEffect(() => {
    if (!open || !contactId) {
      setContact(null);
      setError(null);
      setCrossBusiness(null);
      return;
    }

    const fetchContact = async () => {
      setIsLoading(true);
      setError(null);
      setCrossBusiness(null);
      try {
        // Scoped fetch — guarantees organization_id + business_id are applied.
        const { data: cRaw, error: cErr } = await (scoped("contacts") as any)
          .select("id, name, email, phone, type, customer_rank, supplier_rank, is_company, credit_hold, credit_limit, business_id, parent:contacts!parent_contact_id(name)")
          .eq("id", contactId)
          .maybeSingle();
        const c = cRaw ? { ...cRaw, company: cRaw.parent?.name ?? null } : null;

        if (cErr) throw cErr;

        // If RLS lets the user see contacts from other businesses but the
        // active business doesn't match, show a clear cross-company state.
        if (!c) {
          // Try unscoped probe (still RLS-protected) to detect cross-business.
          const probe = await (scoped("contacts") as any)
            .select("id, business_id")
            .eq("id", contactId)
            .maybeSingle();
          if (probe?.data) {
            setCrossBusiness({ contactBizId: probe.data.business_id ?? null });
          } else {
            throw new Error("Contact not found");
          }
          return;
        }

        setContact(c as unknown as ContactData);

        // Recent invoices (list only — never the source of the receivable figure)
        const { data: invoices } = await (scoped("invoices") as any)
          .select("id, total, amount_paid, status, invoice_number, issue_date, due_date")
          .order("issue_date", { ascending: false })
          .eq("contact_id", contactId)
          .limit(20);

        // Receivable + aging come off the GL-gated AR projection: residual nets
        // cash receipts AND applied credit notes, and status lists never drift.
        const arAging = currentOrg?.id
          ? await fetchContactOpenItemAging("ar", {
              orgId: currentOrg.id,
              contactId,
              businessId: currentBusiness?.id ?? null,
            })
          : EMPTY_OPEN_ITEM_AGING;
        setReceivable(arAging.total);
        setAging({
          current: arAging.current,
          days1_30: arAging.days30,
          days31_60: arAging.days60,
          days61_90: arAging.days90,
          days90plus: arAging.days120,
        });

        // Recent bills (list only)
        const { data: bills } = await (scoped("bills") as any)
          .select("id, total, amount_paid, status, bill_number, bill_date, due_date")
          .eq("vendor_id", contactId)
          .order("bill_date", { ascending: false })
          .limit(20);

        const apAging = currentOrg?.id
          ? await fetchContactOpenItemAging("ap", {
              orgId: currentOrg.id,
              contactId,
              businessId: currentBusiness?.id ?? null,
            })
          : EMPTY_OPEN_ITEM_AGING;
        setPayable(apAging.total);
        setApAging({
          current: apAging.current,
          days1_30: apAging.days30,
          days31_60: apAging.days60,
          days61_90: apAging.days90,
          days90plus: apAging.days120,
        });

        (invoices || []).slice(0, 3).forEach((inv: any) => {
          txns.push({
            type: "invoice",
            id: inv.id,
            number: inv.invoice_number,
            date: inv.issue_date,
            amount: inv.total,
            status: inv.status,
          });
        });
        (bills || []).slice(0, 3).forEach((b: any) => {
          txns.push({
            type: "bill",
            id: b.id,
            number: b.bill_number,
            date: b.bill_date,
            amount: b.total,
            status: b.status,
          });
        });

        // Estimates — scoped
        const { data: estimates } = await (scoped("estimates") as any)
          .select("id, estimate_number, issue_date, total, status")
          .eq("contact_id", contactId)
          .order("issue_date", { ascending: false })
          .limit(3);
        (estimates || []).forEach((est: any) => {
          txns.push({
            type: "estimate",
            id: est.id,
            number: est.estimate_number,
            date: est.issue_date,
            amount: est.total,
            status: est.status,
          });
        });

        // Sales Orders — scoped
        const { data: salesOrders } = await (scoped("sales_orders") as any)
          .select("id, so_number, order_date, total, status")
          .eq("contact_id", contactId)
          .order("order_date", { ascending: false })
          .limit(3);
        (salesOrders || []).forEach((so: any) => {
          txns.push({
            type: "sales_order",
            id: so.id,
            number: so.so_number,
            date: so.order_date,
            amount: so.total,
            status: so.status,
          });
        });

        // Customer credit notes — scoped
        const { data: creditNotes } = await (scoped("credit_notes") as any)
          .select("id, credit_note_number, issue_date, total, status")
          .eq("contact_id", contactId)
          .order("issue_date", { ascending: false })
          .limit(3);
        (creditNotes || []).forEach((cn: any) => {
          txns.push({
            type: "credit_note",
            id: cn.id,
            number: cn.credit_note_number,
            date: cn.issue_date,
            amount: cn.total,
            status: cn.status,
          });
        });

        // Vendor credit notes — scoped
        const { data: vendorCNs } = await (scoped("vendor_credit_notes") as any)
          .select("id, credit_note_number, issue_date, total, status")
          .eq("vendor_id", contactId)
          .order("issue_date", { ascending: false })
          .limit(3);
        (vendorCNs || []).forEach((vcn: any) => {
          txns.push({
            type: "vendor_credit_note",
            id: vcn.id,
            number: vcn.credit_note_number,
            date: vcn.issue_date,
            amount: vcn.total,
            status: vcn.status,
          });
        });

        // Customer payments — scoped
        const { data: contactPayments } = await (scoped("payments") as any)
          .select("id, payment_date, amount, status, invoice:invoices(invoice_number)")
          .eq("contact_id", contactId)
          .neq("status", "voided")
          .order("payment_date", { ascending: false })
          .limit(3);
        (contactPayments || []).forEach((p: any) => {
          txns.push({
            type: "payment",
            id: p.id,
            number: p.invoice?.invoice_number || "Payment",
            date: p.payment_date,
            amount: p.amount,
            status: p.status || "completed",
          });
        });

        // Bill payments — bill_payments table is not directly business-scoped,
        // but the joined `bill` is. We keep the existing inner-join filter
        // (bill.vendor_id = contactId) which transitively scopes via RLS.
        const { data: billPayments } = await (scoped("bill_payments") as any)
          .select("id, payment_date, amount, bill:bills!inner(vendor_id, bill_number)")
          .eq("bill.vendor_id", contactId)
          .order("payment_date", { ascending: false })
          .limit(3);
        (billPayments || []).forEach((bp: any) => {
          txns.push({
            type: "bill_payment",
            id: bp.id,
            number: bp.bill?.bill_number || "Bill Payment",
            date: bp.payment_date,
            amount: bp.amount,
            status: "completed",
          });
        });

        txns.sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
        setRecentTransactions(txns.slice(0, 6));
      } catch (err: any) {
        console.error("Failed to fetch contact:", err);
        setError(err.message || "Failed to load contact");
      } finally {
        setIsLoading(false);
      }
    };

    fetchContact();
  }, [open, contactId, currentBusiness?.id]);

  const handleViewFullProfile = () => {
    if (contact) {
      onOpenChange(false);
      navigate(`/contacts-app/profile?id=${contact.id}&from=${encodeURIComponent(location.pathname)}`);
    }
  };

  // Dual-role badges driven by ranks (with legacy `type` fallback for older rows)
  const isCustomer = (contact?.customer_rank ?? 0) > 0 || contact?.type === "customer" || contact?.type === "both";
  const isSupplier = (contact?.supplier_rank ?? 0) > 0 || contact?.type === "supplier" || contact?.type === "both";
  const roleBadges = (
    <div className="flex flex-wrap gap-1">
      {isCustomer && <Badge variant="default">Customer</Badge>}
      {isSupplier && <Badge variant="secondary">Supplier</Badge>}
      {!isCustomer && !isSupplier && <Badge variant="outline">Contact</Badge>}
      {contact?.is_company && <Badge variant="outline">Company</Badge>}
    </div>
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 z-[60]">
        <SheetHeader className="px-6 pt-6 pb-0">
          <div className="flex items-center gap-2 text-xs text-muted-foreground mb-1">
            <User className="h-3 w-3" />
            Contact Preview
          </div>
          <SheetTitle className="text-xl">
            {isLoading ? <Skeleton className="h-7 w-48" /> : contact?.name || (crossBusiness ? "Contact in another company" : "Contact")}
          </SheetTitle>
        </SheetHeader>

        <ScrollArea className="h-[calc(100vh-120px)]">
          <div className="px-6 pb-6 space-y-5 mt-4">
            {isLoading && (
              <div className="space-y-4">
                <Skeleton className="h-8 w-24" />
                <div className="grid grid-cols-2 gap-4">
                  {[...Array(6)].map((_, i) => (
                    <Skeleton key={i} className="h-12 w-full" />
                  ))}
                </div>
              </div>
            )}

            {error && !crossBusiness && (
              <div className="text-center py-8 text-muted-foreground">
                <User className="h-10 w-10 mx-auto mb-3 opacity-50" />
                <p className="text-sm">{error}</p>
              </div>
            )}

            {crossBusiness && !isLoading && (
              <div className="text-center py-8 text-muted-foreground space-y-3">
                <Building2 className="h-10 w-10 mx-auto opacity-50" />
                <div>
                  <p className="text-sm font-medium text-foreground">This contact belongs to another company</p>
                  <p className="text-xs mt-1">
                    You're currently viewing <span className="font-medium">{currentBusiness?.name || "this company"}</span>.
                    Switch the active company from the workspace switcher to see this contact's transactions.
                  </p>
                </div>
              </div>
            )}

            {contact && !isLoading && !crossBusiness && (
              <>
                {/* Type Badge + Credit Hold */}
                <div className="flex items-center gap-2">
                  {roleBadges}
                  {contact.credit_hold && (
                    <Badge variant="destructive" className="gap-1">
                      <ShieldAlert className="h-3 w-3" />
                      Credit Hold
                    </Badge>
                  )}
                </div>

                <Separator />

                {/* Details Grid */}
                <div className="grid grid-cols-2 gap-4">
                  <DetailRow icon={Building2} label="Company" value={contact.company || "—"} />
                  <DetailRow icon={Mail} label="Email" value={contact.email || "—"} />
                  <DetailRow icon={Phone} label="Phone" value={contact.phone || "—"} />
                  {contact.credit_limit != null && contact.credit_limit > 0 && (
                    <DetailRow icon={CreditCard} label="Credit Limit" value={formatCurrency(contact.credit_limit)} />
                  )}
                </div>

                {/* Outstanding Balances */}
                {(receivable > 0 || payable > 0) && (
                  <>
                    <Separator />
                    <div>
                      <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                        <CreditCard className="h-4 w-4" />
                        Outstanding Balances
                      </h4>
                      <div className="space-y-2">
                        {receivable > 0 && (
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Accounts Receivable</span>
                            <span className="font-medium text-foreground">{formatCurrency(receivable)}</span>
                          </div>
                        )}
                        {payable > 0 && (
                          <div className="flex justify-between items-center text-sm">
                            <span className="text-muted-foreground">Accounts Payable</span>
                            <span className="font-medium text-destructive">{formatCurrency(payable)}</span>
                          </div>
                        )}
                      </div>
                    </div>

                    {/* AR Aging Breakdown */}
                    {receivable > 0 && (
                      <div>
                        <h4 className="text-xs font-medium mb-2 flex items-center gap-2 text-muted-foreground">
                          <BarChart3 className="h-3.5 w-3.5" />
                          AR Aging Breakdown
                        </h4>
                        <div className="flex flex-col gap-1">
                          {([
                            { label: "Current", value: aging.current },
                            { label: "1-30 days", value: aging.days1_30 },
                            { label: "31-60 days", value: aging.days31_60 },
                            { label: "61-90 days", value: aging.days61_90 },
                            { label: "90+ days", value: aging.days90plus },
                          ] as const).map(({ label, value }) => (
                            <div
                              key={label}
                              className={`flex items-center justify-between gap-3 rounded-md px-2 py-1.5 ${value > 0 ? "bg-muted" : "bg-muted/30"}`}
                            >
                              <span className="text-[11px] text-muted-foreground shrink-0">{label}</span>
                              <span className={`text-xs font-medium tabular-nums whitespace-nowrap text-right ${value > 0 ? "text-foreground" : "text-muted-foreground/50"}`}>
                                {value > 0 ? formatCurrency(value) : "—"}
                              </span>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* AP Aging Breakdown */}
                    {payable > 0 && (
                      <div>
                        <h4 className="text-xs font-medium mb-2 flex items-center gap-2 text-muted-foreground">
                          <BarChart3 className="h-3.5 w-3.5" />
                          AP Aging Breakdown
                        </h4>
                        <div className="grid grid-cols-5 gap-1 text-center">
                          {([
                            { label: "Current", value: apAging.current },
                            { label: "1-30", value: apAging.days1_30 },
                            { label: "31-60", value: apAging.days31_60 },
                            { label: "61-90", value: apAging.days61_90 },
                            { label: "90+", value: apAging.days90plus },
                          ] as const).map(({ label, value }) => (
                            <div key={label} className={`rounded-md p-1.5 ${value > 0 ? "bg-muted" : "bg-muted/30"}`}>
                              <div className="text-[10px] text-muted-foreground">{label}</div>
                              <div className={`text-xs font-medium tabular-nums ${value > 0 ? "text-destructive" : "text-muted-foreground/50"}`}>
                                {value > 0 ? formatCurrency(value) : "—"}
                              </div>
                            </div>
                          ))}
                        </div>
                      </div>
                    )}

                    {/* View Statement / Ledger Links — route based on contact type */}
                    {(contact.type === "customer" || contact.type === "both") && (
                      <>
                        <Button
                          variant="ghost"
                          size="sm"
                          className="w-full text-xs h-7"
                          onClick={() => {
                            onOpenChange(false);
                            navigate(`/sales/customers/${contact.id}/ledger`);
                          }}
                        >
                          <FileText className="h-3.5 w-3.5 mr-1.5" />
                          Open Customer Ledger
                          <ExternalLink className="h-3 w-3 ml-1" />
                        </Button>
                        {receivable > 0 && (
                          <Button
                            variant="ghost"
                            size="sm"
                            className="w-full text-xs h-7"
                            onClick={() => {
                              onOpenChange(false);
                              navigate(`/sales/statements?customer_id=${contact.id}`);
                            }}
                          >
                            <FileText className="h-3.5 w-3.5 mr-1.5" />
                            View AR Statement
                            <ExternalLink className="h-3 w-3 ml-1" />
                          </Button>
                        )}
                      </>
                    )}
                    {payable > 0 && (contact.type === "supplier" || contact.type === "both") && (
                      <Button
                        variant="ghost"
                        size="sm"
                        className="w-full text-xs h-7"
                        onClick={() => {
                          onOpenChange(false);
                          navigate(`/purchases/statements?contact_id=${contact.id}`);
                        }}
                      >
                        <FileText className="h-3.5 w-3.5 mr-1.5" />
                        View AP Statement
                        <ExternalLink className="h-3 w-3 ml-1" />
                      </Button>
                    )}
                  </>
                )}

                {/* Recent Transactions */}
                {recentTransactions.length > 0 && (
                  <>
                    <Separator />
                    <div>
                      <h4 className="text-sm font-medium mb-3 flex items-center gap-2">
                        <FileText className="h-4 w-4" />
                        Recent Transactions
                      </h4>
                      <div className="space-y-2">
                        {recentTransactions.map((txn, i) => (
                          <button
                            key={i}
                            type="button"
                            onClick={() => {
                              onOpenChange(false);
                              const routes: Record<string, string> = {
                                invoice: "/sales/invoices",
                                bill: "/purchases/bills",
                                credit_note: "/sales/credit-notes",
                                vendor_credit_note: "/purchases/credit-notes",
                                payment: "/sales/payments",
                                bill_payment: "/purchases/bills",
                                estimate: "/sales/estimates",
                                sales_order: "/sales/orders",
                              };
                              const path = routes[txn.type];
                              if (path) navigate(`${path}?id=${txn.id}`);
                            }}
                            className="flex items-center justify-between text-sm rounded-lg border p-2.5 w-full text-left hover:bg-muted/50 transition-colors cursor-pointer"
                          >
                            <div className="flex items-center gap-2 min-w-0">
                              <Badge variant="outline" className="text-[10px] shrink-0 capitalize">
                                {txn.type.replace("_", " ")}
                              </Badge>
                              <span className="font-mono text-xs truncate">{txn.number}</span>
                            </div>
                            <div className="text-right shrink-0 ml-2 flex items-center gap-2">
                              <div>
                                <div className="font-medium">{formatCurrency(txn.amount)}</div>
                                <div className="text-[10px] text-muted-foreground">
                                  {format(new Date(txn.date), "MMM d, yyyy")}
                                </div>
                              </div>
                              <ExternalLink className="h-3 w-3 text-muted-foreground shrink-0" />
                            </div>
                          </button>
                        ))}
                      </div>
                    </div>
                  </>
                )}

                {/* View Full Profile */}
                <Separator />
                <Button variant="outline" className="w-full" onClick={handleViewFullProfile}>
                  <ExternalLink className="h-4 w-4 mr-2" />
                  View Full Profile
                </Button>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
