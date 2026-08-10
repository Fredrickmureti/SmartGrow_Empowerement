// @ts-nocheck
import { ContactAddressesSection } from "@/components/contacts/ContactAddressesSection";
/**
 * Unified Contact Profile Page - 360-degree business view
 * 
 * Shows all ERP data related to a contact across CRM, Sales, Purchases, Finance.
 * Includes Phase 3 enhancements: Accounting defaults, aging breakdown, credit status, activity timeline.
 */
import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, Mail, Phone, Building2, Plus, Loader2, FileText,
  ShoppingCart, Briefcase, CreditCard, Wallet, Eye, TrendingUp,
  Target, Users, Receipt, Pencil, Archive, DollarSign, ClipboardList, Star,
} from "lucide-react";
import { useContactProfile } from "@/hooks/useContactProfile";
import { useContactsPaginated } from "@/hooks/useContactsPaginated";
import { useCurrency } from "@/hooks/useCurrency";
import { useCreditNotes } from "@/hooks/useCreditNotes";
import { format, parseISO } from "date-fns";
import { cn } from "@/lib/utils";
// Apply-credit is a routed wizard at /finance/customer-credits/:id/apply.
import { CreditNotePeekSheet } from "@/features/sales/credit-notes/CreditNotePeekSheet";
import { LeadDetailsDialog } from "@/components/crm/LeadDetailsDialog";
import { LeadForm } from "@/components/crm/LeadForm";
import { useLeads } from "@/hooks/crm/useLeads";
import { ReportExportButtons } from "@/components/reports/ReportExportButtons";
import { type ExportConfig, type ExportColumn } from "@/services/reports/ReportExportService";
import { ContactAccountingDefaults } from "@/components/contacts/ContactAccountingDefaults";
import { ContactAgingBreakdown } from "@/components/contacts/ContactAgingBreakdown";
import { ContactCreditStatus } from "@/components/contacts/ContactCreditStatus";
import { ContactActivityTimeline } from "@/components/contacts/ContactActivityTimeline";
import { SendSmsButton } from "@/components/sms/SendSmsButton";
import { supabase } from "@/integrations/supabase/client";
import { CustomFieldsSection } from "@/components/studio/CustomFieldsSection";
import { rolesFromContact } from "@/lib/contactRoles";
import { useContactHierarchy } from "@/hooks/useContactHierarchy";

export default function ContactProfile() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const contactId = searchParams.get("id") || "";
  const fromContext = searchParams.get("from");
  const { formatCurrency } = useCurrency();
  const { deleteLead } = useLeads();
  const { archiveContact } = useContactsPaginated();

  const profile = useContactProfile(contactId);
  const { contact } = profile;
  const hierarchy = useContactHierarchy(
    contactId,
    ((contact as any)?.commercial_partner_id ?? contactId) || contactId,
  );

  // Dialog state
  // Apply-credit is a routed wizard now — no local state needed.
  const [peekCreditNoteId, setPeekCreditNoteId] = useState<string | null>(null);
  const [selectedLead, setSelectedLead] = useState<any>(null);
  const [showLeadDetails, setShowLeadDetails] = useState(false);
  const [showLeadForm, setShowLeadForm] = useState(false);

  if (!contactId) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <Building2 className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">No contact selected.</p>
        <Button onClick={() => navigate(-1)}>Go Back</Button>
      </div>
    );
  }

  if (profile.isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!contact) {
    return (
      <div className="flex flex-col items-center justify-center py-16 gap-4">
        <Building2 className="h-12 w-12 text-muted-foreground" />
        <p className="text-muted-foreground">Contact not found.</p>
        <Button onClick={() => navigate(-1)}>Go Back</Button>
      </div>
    );
  }

  const { isCustomer, isSupplier } = rolesFromContact(contact as any);


  const getStatusColor = (status: string) => {
    switch (status) {
      case "paid": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "sent": case "approved": case "confirmed": return "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200";
      case "overdue": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      case "draft": return "bg-muted text-muted-foreground";
      case "won": return "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200";
      case "lost": return "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200";
      default: return "bg-yellow-100 text-yellow-800 dark:bg-yellow-900 dark:text-yellow-200";
    }
  };

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="space-y-3">
        <div className="flex items-center gap-2">
          <Button
            variant="ghost"
            size="sm"
            className="gap-1 shrink-0"
            onClick={() => {
              if (fromContext === "crm") {
                navigate("/crm-app/pipeline");
              } else {
                navigate(-1);
              }
            }}
          >
            <ArrowLeft className="h-4 w-4" />
            <span className="hidden sm:inline">{fromContext === "crm" ? "Back to Pipeline" : "Back"}</span>
          </Button>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="text-xl sm:text-2xl font-bold truncate">{contact.name}</h1>
              {isCustomer && <Badge variant="default" className="shrink-0">Customer</Badge>}
              {isSupplier && <Badge variant="secondary" className="shrink-0">Supplier</Badge>}
              {(contact as any).is_company && (
                <Badge variant="outline" className="shrink-0 gap-1">
                  <Building2 className="h-3 w-3" />
                  Company{hierarchy.children.length > 0 ? ` · ${hierarchy.children.length} contacts` : ""}
                </Badge>
              )}
              {hierarchy.parent && (
                <Badge
                  variant="outline"
                  className="shrink-0 cursor-pointer hover:bg-muted gap-1"
                  onClick={() => navigate(`/contacts-app/profile?id=${hierarchy.parent!.id}`)}
                >
                  <Building2 className="h-3 w-3" />
                  Part of {hierarchy.parent.name}
                </Badge>
              )}
              {!contact.is_active && <Badge variant="secondary" className="shrink-0">Inactive</Badge>}
            </div>
            <div className="flex flex-wrap items-center gap-x-4 gap-y-1 text-sm text-muted-foreground mt-1">
              {contact.company && (
                <span className="flex items-center gap-1 truncate"><Building2 className="h-3 w-3 shrink-0" />{contact.company}</span>
              )}
              {contact.email && (
                <span className="flex items-center gap-1 truncate"><Mail className="h-3 w-3 shrink-0" />{contact.email}</span>
              )}
              {contact.phone && (
                <span className="flex items-center gap-1"><Phone className="h-3 w-3 shrink-0" />{contact.phone}</span>
              )}
            </div>
          </div>
        </div>
        <div className="flex gap-2 flex-wrap">
          {/* Customer actions */}
          {isCustomer && (
            <Button size="sm" onClick={() => navigate(`/sales/invoices?action=create&contact_id=${contactId}`)}>
              <Plus className="mr-1 h-4 w-4" /> Invoice
            </Button>
          )}
          {isCustomer && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/sales/estimates?action=create&contact_id=${contactId}`)}>
              <FileText className="mr-1 h-4 w-4" /> Estimate
            </Button>
          )}
          {isCustomer && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/sales/credit-notes?action=create&contact_id=${contactId}`)}>
              <Receipt className="mr-1 h-4 w-4" /> Credit Note
            </Button>
          )}
          {isCustomer && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/sales/payments?action=create&contact_id=${contactId}`)}>
              <CreditCard className="mr-1 h-4 w-4" /> Receive Payment
            </Button>
          )}
          {isCustomer && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/sales/statements?contact_id=${contactId}`)}>
              <Eye className="mr-1 h-4 w-4" /> Statement
            </Button>
          )}
          {/* Supplier actions */}
          {isSupplier && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/purchases/bills?action=create&contact_id=${contactId}`)}>
              <Plus className="mr-1 h-4 w-4" /> Bill
            </Button>
          )}
          {isSupplier && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/expenses?action=create&contact_id=${contactId}`)}>
              <DollarSign className="mr-1 h-4 w-4" /> Expense
            </Button>
          )}
          {isSupplier && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/purchases/orders?action=create&contact_id=${contactId}`)}>
              <ClipboardList className="mr-1 h-4 w-4" /> Purchase Order
            </Button>
          )}
          {isSupplier && (
            <Button size="sm" variant="outline" onClick={() => navigate(`/purchases/bills?action=record-payment&contact_id=${contactId}`)}>
              <Wallet className="mr-1 h-4 w-4" /> Record Payment
            </Button>
          )}
          {/* General actions */}
          <Button
            size="sm"
            variant="outline"
            onClick={async () => {
              const newPinned = !(contact as any).is_pinned;
              await supabase.from("contacts").update({ is_pinned: newPinned } as any).eq("id", contactId);
            }}
          >
            <Star className={cn("mr-1 h-4 w-4", (contact as any).is_pinned && "fill-yellow-400 text-yellow-400")} />
            {(contact as any).is_pinned ? "Unpin" : "Pin"}
          </Button>
          <Button size="sm" variant="outline" onClick={() => setShowLeadForm(true)}>
            <Briefcase className="mr-1 h-4 w-4" /> New Lead
          </Button>
          <SendSmsButton
            recipientPhone={contact.phone || ""}
            recipientName={contact.name}
            context={{
              entityType: "contact",
              entityId: contactId,
            }}
          />
          <Button size="sm" variant="outline" onClick={() => navigate(`/contacts-app?action=edit&id=${contactId}`)}>
            <Pencil className="mr-1 h-4 w-4" /> Edit
          </Button>
          {contact.is_active && (
            <Button
              size="sm"
              variant="outline"
              className="text-destructive border-destructive/30 hover:bg-destructive/10"
              onClick={async () => {
                try {
                  await archiveContact(contactId);
                } catch (e) {
                  // handled by hook
                }
              }}
            >
              <Archive className="mr-1 h-4 w-4" /> Archive
            </Button>
          )}
          <ReportExportButtons
            compact
            formats={["excel", "csv", "print", "pdf"]}
            getExportConfig={() => {
              const cols: ExportColumn[] = [
                { key: "type", header: "Type", width: 12 },
                { key: "ref", header: "Reference", width: 18 },
                { key: "date", header: "Date", width: 14 },
                { key: "status", header: "Status", width: 12 },
                { key: "amount", header: "Amount", format: "currency", width: 16, align: "right" },
                { key: "balance", header: "Balance", format: "currency", width: 16, align: "right" },
              ];
              const rows: Record<string, any>[] = [];
              profile.invoices.forEach(inv => rows.push({ type: "Invoice", ref: inv.invoice_number, date: inv.issue_date, status: inv.status, amount: inv.total || 0, balance: (inv.total || 0) - (inv.amount_paid || 0) }));
              profile.bills.forEach(b => rows.push({ type: "Bill", ref: b.bill_number, date: b.bill_date, status: b.status, amount: b.total || 0, balance: (b.total || 0) - (b.amount_paid || 0) }));
              profile.payments.forEach(p => rows.push({ type: "Payment", ref: p.reference || p.id.slice(0, 8), date: p.payment_date, status: "completed", amount: p.amount || 0, balance: 0 }));
              profile.billPayments.forEach(bp => rows.push({ type: "Bill Payment", ref: bp.reference || bp.id.slice(0, 8), date: bp.payment_date, status: "completed", amount: bp.amount || 0, balance: 0 }));
              profile.creditNotes.forEach(cn => rows.push({ type: "Credit Note", ref: cn.credit_note_number, date: cn.issue_date, status: cn.status, amount: cn.total || 0, balance: cn.total - cn.amount_applied }));
              profile.crmLeads.forEach(l => rows.push({ type: "Lead", ref: l.name, date: l.created_at?.split("T")[0], status: l.won_at ? "Won" : l.lost_at ? "Lost" : "Open", amount: l.expected_revenue || 0, balance: 0 }));
              rows.sort((a, b) => (b.date || "").localeCompare(a.date || ""));
              return {
                title: `Activity Report – ${contact.name}`,
                companyName: contact.company || contact.name,
                columns: cols,
                rows,
              } as ExportConfig;
            }}
          />
        </div>
      </div>

      {/* KPI Cards */}
      <div className="grid gap-4 grid-cols-2 md:grid-cols-3 lg:grid-cols-6">
        {isCustomer && (
          <>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Total Revenue</p>
                <p className="text-lg font-bold">{formatCurrency(profile.totalRevenue)}</p>
                <p className="text-xs text-muted-foreground">{profile.invoices.length} invoices</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Outstanding</p>
                <p className={cn("text-lg font-bold", profile.outstandingReceivable > 0 ? "text-destructive" : "text-emerald-600")}>
                  {formatCurrency(profile.outstandingReceivable)}
                </p>
                <Button
                  variant="link"
                  size="sm"
                  className="h-auto p-0 mt-1 text-xs"
                  onClick={() => navigate(`/sales/customers/${contact.id}/ledger`)}
                >
                  Open Customer Ledger →
                </Button>
              </CardContent>
            </Card>

            <Card className="border-l-4 border-l-primary">
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Credit Balance</p>
                <p className={cn("text-lg font-bold", profile.totalCreditAvailable > 0 ? "text-primary" : "text-muted-foreground")}>
                  {formatCurrency(profile.totalCreditAvailable)}
                </p>
              </CardContent>
            </Card>
          </>
        )}
        {isSupplier && (
          <>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Total Purchases</p>
                <p className="text-lg font-bold">{formatCurrency(profile.totalPurchases)}</p>
                <p className="text-xs text-muted-foreground">{profile.bills.length} bills</p>
              </CardContent>
            </Card>
            <Card>
              <CardContent className="p-4">
                <p className="text-xs text-muted-foreground">Outstanding Payable</p>
                <p className={cn("text-lg font-bold", profile.outstandingPayable > 0 ? "text-destructive" : "text-emerald-600")}>
                  {formatCurrency(profile.outstandingPayable)}
                </p>
              </CardContent>
            </Card>
          </>
        )}
        <Card className="border-l-4 border-l-teal-500">
          <CardContent className="p-4">
            <p className="text-xs text-muted-foreground">Open Opportunities</p>
            <p className="text-lg font-bold">{profile.openOpportunities}</p>
            <p className="text-xs text-muted-foreground">{profile.crmLeads.length} total leads</p>
          </CardContent>
        </Card>
      </div>

      {/* Tabs */}
      <Tabs defaultValue="overview">
        <TabsList className="flex w-full overflow-x-auto scrollbar-hide h-auto p-1 gap-1">
          <TabsTrigger value="overview" className="flex-shrink-0 text-xs sm:text-sm">Overview</TabsTrigger>
          <TabsTrigger value="crm" className="flex-shrink-0 text-xs sm:text-sm">CRM ({profile.crmLeads.length})</TabsTrigger>
          {isCustomer && <TabsTrigger value="sales" className="flex-shrink-0 text-xs sm:text-sm">Sales ({profile.invoices.length + profile.salesOrders.length})</TabsTrigger>}
          {isSupplier && <TabsTrigger value="purchases" className="flex-shrink-0 text-xs sm:text-sm">Purchases ({profile.bills.length + profile.purchaseOrders.length})</TabsTrigger>}
          <TabsTrigger value="payments" className="flex-shrink-0 text-xs sm:text-sm">Payments ({profile.payments.length + profile.billPayments.length})</TabsTrigger>
          {isCustomer && <TabsTrigger value="credits" className="flex-shrink-0 text-xs sm:text-sm">Credits ({profile.creditNotes.length})</TabsTrigger>}
          <TabsTrigger value="activity" className="flex-shrink-0 text-xs sm:text-sm">Activity</TabsTrigger>
          <TabsTrigger value="info" className="flex-shrink-0 text-xs sm:text-sm">Info</TabsTrigger>
          <TabsTrigger value="hierarchy" className="flex-shrink-0 text-xs sm:text-sm">
            Hierarchy{hierarchy.children.length + hierarchy.siblings.length > 0 ? ` (${hierarchy.children.length + hierarchy.siblings.length})` : ""}
          </TabsTrigger>
          <TabsTrigger value="custom" className="flex-shrink-0 text-xs sm:text-sm">Custom Fields</TabsTrigger>
        </TabsList>

        {/* Overview Tab */}
        <TabsContent value="overview" className="mt-4 space-y-4">
          {/* Phase 3: Accounting Defaults, Credit Status, Aging */}
          <div className="grid gap-4 md:grid-cols-3">
            <ContactAccountingDefaults contact={contact} />
            <ContactCreditStatus contactId={contactId} contactType={contact.type} />
            <ContactAgingBreakdown contactId={contactId} contactType={contact.type} />
          </div>
          <div className="grid gap-4 md:grid-cols-2">
            {/* Recent CRM Activity */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Briefcase className="h-4 w-4" /> Recent Opportunities
                </CardTitle>
              </CardHeader>
              <CardContent>
                {profile.crmLeads.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No CRM leads linked</p>
                ) : (
                  <div className="space-y-2">
                    {profile.crmLeads.slice(0, 5).map(lead => (
                      <div
                        key={lead.id}
                        className="flex items-center justify-between text-sm cursor-pointer hover:bg-muted/50 rounded p-2 -mx-2"
                        onClick={() => { setSelectedLead(lead); setShowLeadDetails(true); }}
                      >
                        <div>
                          <p className="font-medium">{lead.name}</p>
                          {lead.stage && (
                            <Badge
                              className="text-xs mt-0.5"
                              style={{ backgroundColor: lead.stage.color || "#6b7280", color: "white" }}
                            >
                              {lead.stage.name}
                            </Badge>
                          )}
                        </div>
                        <div className="text-right">
                          {lead.expected_revenue > 0 && (
                            <p className="font-medium text-emerald-600">{formatCurrency(lead.expected_revenue)}</p>
                          )}
                          {lead.won_at && <Badge className="bg-green-100 text-green-800 text-xs">Won</Badge>}
                          {lead.lost_at && <Badge className="bg-red-100 text-red-800 text-xs">Lost</Badge>}
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </CardContent>
            </Card>

            {/* Recent Transactions */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium flex items-center gap-2">
                  <Receipt className="h-4 w-4" /> Recent Transactions
                </CardTitle>
              </CardHeader>
              <CardContent>
                {profile.invoices.length === 0 && profile.bills.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No transactions yet</p>
                ) : (
                  <div className="space-y-2">
                    {[
                      ...profile.invoices.slice(0, 3).map(inv => ({
                        id: inv.id,
                        type: "Invoice",
                        number: inv.invoice_number,
                        date: inv.issue_date,
                        amount: inv.total,
                        status: inv.status,
                      })),
                      ...profile.bills.slice(0, 3).map(bill => ({
                        id: bill.id,
                        type: "Bill",
                        number: bill.bill_number,
                        date: bill.bill_date,
                        amount: bill.total,
                        status: bill.status,
                      })),
                    ]
                      .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime())
                      .slice(0, 5)
                      .map(item => (
                        <div key={item.id} className="flex items-center justify-between text-sm p-2 -mx-2">
                          <div className="flex items-center gap-2">
                            <Badge variant="outline" className="text-xs">{item.type}</Badge>
                            <span className="font-mono text-xs">{item.number}</span>
                          </div>
                          <div className="flex items-center gap-2">
                            <Badge className={cn("text-xs", getStatusColor(item.status))}>{item.status}</Badge>
                            <span className="font-medium">{formatCurrency(item.amount || 0)}</span>
                          </div>
                        </div>
                      ))}
                  </div>
                )}
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* CRM Tab */}
        <TabsContent value="crm" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Lead</TableHead>
                    <TableHead className="hidden sm:table-cell">Stage</TableHead>
                    <TableHead>Expected Revenue</TableHead>
                    <TableHead className="hidden md:table-cell">Probability</TableHead>
                    <TableHead>Status</TableHead>
                    <TableHead className="hidden sm:table-cell">Created</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profile.crmLeads.length === 0 ? (
                    <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No CRM leads</TableCell></TableRow>
                  ) : (
                    profile.crmLeads.map(lead => (
                      <TableRow
                        key={lead.id}
                        className="cursor-pointer hover:bg-muted/30"
                        onClick={() => { setSelectedLead(lead); setShowLeadDetails(true); }}
                      >
                        <TableCell>
                          <div>
                            <p className="font-medium text-sm">{lead.name}</p>
                            <p className="text-xs text-muted-foreground font-mono">{lead.lead_number}</p>
                          </div>
                        </TableCell>
                        <TableCell className="hidden sm:table-cell">
                          {lead.stage && (
                            <Badge style={{ backgroundColor: lead.stage.color || "#6b7280", color: "white" }}>
                              {lead.stage.name}
                            </Badge>
                          )}
                        </TableCell>
                        <TableCell className="font-medium">{formatCurrency(lead.expected_revenue || 0)}</TableCell>
                        <TableCell className="hidden md:table-cell">{lead.probability || 0}%</TableCell>
                        <TableCell>
                          {lead.won_at ? <Badge className="bg-green-100 text-green-800">Won</Badge> :
                           lead.lost_at ? <Badge className="bg-red-100 text-red-800">Lost</Badge> :
                           <Badge variant="outline">Open</Badge>}
                        </TableCell>
                        <TableCell className="text-sm hidden sm:table-cell">{format(new Date(lead.created_at), "MMM d, yyyy")}</TableCell>
                      </TableRow>
                    ))
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Sales Tab */}
        {isCustomer && (
          <TabsContent value="sales" className="mt-4 space-y-4">
            {/* Sales Orders */}
            {profile.salesOrders.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Sales Orders ({profile.salesOrders.length})</CardTitle>
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>SO #</TableHead>
                        <TableHead className="hidden sm:table-cell">Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {profile.salesOrders.map(so => (
                        <TableRow key={so.id} className="cursor-pointer hover:bg-muted/30">
                          <TableCell className="font-mono text-sm">{so.so_number}</TableCell>
                          <TableCell className="text-sm hidden sm:table-cell">{so.order_date ? format(new Date(so.order_date), "MMM d, yyyy") : "—"}</TableCell>
                          <TableCell><Badge className={getStatusColor(so.status)}>{so.status}</Badge></TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(so.total || 0)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Invoices */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Invoices ({profile.invoices.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Invoice #</TableHead>
                      <TableHead className="hidden sm:table-cell">Date</TableHead>
                      <TableHead className="hidden md:table-cell">Due Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">Balance Due</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profile.invoices.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No invoices</TableCell></TableRow>
                    ) : (
                      profile.invoices.map(inv => (
                        <TableRow key={inv.id} className="cursor-pointer hover:bg-muted/30">
                          <TableCell className="font-mono text-sm">{inv.invoice_number}</TableCell>
                          <TableCell className="text-sm hidden sm:table-cell">{inv.issue_date ? format(new Date(inv.issue_date), "MMM d, yyyy") : "—"}</TableCell>
                          <TableCell className="text-sm hidden md:table-cell">{inv.due_date ? format(new Date(inv.due_date), "MMM d, yyyy") : "—"}</TableCell>
                          <TableCell><Badge className={getStatusColor(inv.status)}>{inv.status}</Badge></TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(inv.total || 0)}</TableCell>
                          <TableCell className="text-right font-medium hidden sm:table-cell">{formatCurrency((inv.total || 0) - (inv.amount_paid || 0))}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Purchases Tab */}
        {isSupplier && (
          <TabsContent value="purchases" className="mt-4 space-y-4">
            {/* Purchase Orders */}
            {profile.purchaseOrders.length > 0 && (
              <Card>
                <CardHeader className="pb-3">
                  <CardTitle className="text-sm font-medium">Purchase Orders ({profile.purchaseOrders.length})</CardTitle>
                </CardHeader>
                <CardContent className="p-0 overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>PO #</TableHead>
                        <TableHead className="hidden sm:table-cell">Date</TableHead>
                        <TableHead>Status</TableHead>
                        <TableHead className="text-right">Total</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {profile.purchaseOrders.map(po => (
                        <TableRow key={po.id} className="cursor-pointer hover:bg-muted/30">
                          <TableCell className="font-mono text-sm">{po.po_number}</TableCell>
                          <TableCell className="text-sm hidden sm:table-cell">{po.order_date ? format(new Date(po.order_date), "MMM d, yyyy") : "—"}</TableCell>
                          <TableCell><Badge className={getStatusColor(po.status)}>{po.status}</Badge></TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(po.total || 0)}</TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </CardContent>
              </Card>
            )}

            {/* Bills */}
            <Card>
              <CardHeader className="pb-3">
                <CardTitle className="text-sm font-medium">Bills ({profile.bills.length})</CardTitle>
              </CardHeader>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Bill #</TableHead>
                      <TableHead className="hidden sm:table-cell">Date</TableHead>
                      <TableHead className="hidden md:table-cell">Due Date</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="text-right">Total</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">Balance Due</TableHead>
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profile.bills.length === 0 ? (
                      <TableRow><TableCell colSpan={6} className="text-center py-8 text-muted-foreground">No bills</TableCell></TableRow>
                    ) : (
                      profile.bills.map(bill => (
                        <TableRow key={bill.id} className="cursor-pointer hover:bg-muted/30">
                          <TableCell className="font-mono text-sm">{bill.bill_number}</TableCell>
                          <TableCell className="text-sm hidden sm:table-cell">{bill.bill_date ? format(new Date(bill.bill_date), "MMM d, yyyy") : "—"}</TableCell>
                          <TableCell className="text-sm hidden md:table-cell">{bill.due_date ? format(new Date(bill.due_date), "MMM d, yyyy") : "—"}</TableCell>
                          <TableCell><Badge className={getStatusColor(bill.status)}>{bill.status}</Badge></TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(bill.total || 0)}</TableCell>
                          <TableCell className="text-right font-medium hidden sm:table-cell">{formatCurrency((bill.total || 0) - (bill.amount_paid || 0))}</TableCell>
                        </TableRow>
                      ))
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Payments Tab */}
        <TabsContent value="payments" className="mt-4">
          <Card>
            <CardContent className="p-0 overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Date</TableHead>
                    <TableHead className="hidden sm:table-cell">Reference</TableHead>
                    <TableHead className="hidden md:table-cell">Method</TableHead>
                    <TableHead className="hidden sm:table-cell">Invoice</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {profile.payments.length === 0 && profile.billPayments.length === 0 ? (
                    <TableRow><TableCell colSpan={5} className="text-center py-8 text-muted-foreground">No payments</TableCell></TableRow>
                  ) : (
                    <>
                      {profile.payments.map(payment => (
                        <TableRow key={payment.id}>
                          <TableCell className="text-sm">{payment.payment_date ? format(new Date(payment.payment_date), "MMM d, yyyy") : "—"}</TableCell>
                          <TableCell className="font-mono text-sm hidden sm:table-cell">{payment.reference || "—"}</TableCell>
                          <TableCell className="text-sm hidden md:table-cell">{payment.payment_method || "—"}</TableCell>
                          <TableCell className="text-sm hidden sm:table-cell">{payment.invoice?.invoice_number || "—"}</TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(payment.amount || 0)}</TableCell>
                        </TableRow>
                      ))}
                      {profile.billPayments.map(bp => (
                        <TableRow key={`bp-${bp.id}`}>
                          <TableCell className="text-sm">{bp.payment_date ? format(new Date(bp.payment_date), "MMM d, yyyy") : "—"}</TableCell>
                          <TableCell className="font-mono text-sm hidden sm:table-cell">{bp.reference || "—"}</TableCell>
                          <TableCell className="text-sm hidden md:table-cell">{bp.payment_method || "Bill Payment"}</TableCell>
                          <TableCell className="text-sm hidden sm:table-cell">{bp.bill?.bill_number || "—"}</TableCell>
                          <TableCell className="text-right font-medium">{formatCurrency(bp.amount || 0)}</TableCell>
                        </TableRow>
                      ))}
                    </>
                  )}
                </TableBody>
              </Table>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Credits Tab */}
        {isCustomer && (
          <TabsContent value="credits" className="mt-4">
            <Card>
              <CardContent className="p-0 overflow-x-auto">
                <Table>
                  <TableHeader>
                    <TableRow>
                      <TableHead>Credit Note #</TableHead>
                      <TableHead className="hidden sm:table-cell">Date</TableHead>
                      <TableHead className="hidden md:table-cell">Reason</TableHead>
                      <TableHead className="text-right hidden sm:table-cell">Total</TableHead>
                      <TableHead className="text-right hidden md:table-cell">Applied</TableHead>
                      <TableHead className="text-right">Available</TableHead>
                      <TableHead>Status</TableHead>
                      <TableHead className="w-[80px]" />
                    </TableRow>
                  </TableHeader>
                  <TableBody>
                    {profile.creditNotes.length === 0 ? (
                      <TableRow><TableCell colSpan={8} className="text-center py-8 text-muted-foreground">No credit notes</TableCell></TableRow>
                    ) : (
                      profile.creditNotes.map(cn => {
                        const available = cn.total - cn.amount_applied;
                        return (
                          <TableRow key={cn.id}>
                            <TableCell className="font-mono text-sm">{cn.credit_note_number}</TableCell>
                            <TableCell className="text-sm hidden sm:table-cell">{format(parseISO(cn.issue_date), "MMM d, yyyy")}</TableCell>
                            <TableCell className="text-sm text-muted-foreground max-w-[200px] truncate hidden md:table-cell">{cn.reason || "—"}</TableCell>
                            <TableCell className="text-right text-sm hidden sm:table-cell">{formatCurrency(cn.total)}</TableCell>
                            <TableCell className="text-right text-sm text-emerald-600 hidden md:table-cell">{formatCurrency(cn.amount_applied)}</TableCell>
                            <TableCell className="text-right font-semibold text-sm">
                              {available > 0 ? (
                                <span className="text-primary">{formatCurrency(available)}</span>
                              ) : (
                                <span className="text-muted-foreground">{formatCurrency(0)}</span>
                              )}
                            </TableCell>
                            <TableCell>
                              {available > 0 ? (
                                <Badge variant="default" className="text-xs">Open</Badge>
                              ) : (
                                <Badge variant="secondary" className="text-xs">Applied</Badge>
                              )}
                            </TableCell>
                            <TableCell>
                              <div className="flex gap-1">
                                <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => setPeekCreditNoteId(cn.id)}>
                                  <Eye className="h-4 w-4" />
                                </Button>
                                {available > 0 && (
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => navigate(`/finance/customer-credits/${cn.id}/apply?returnTo=/contacts-app/profile?id=${contactId}`)}>
                                    <Wallet className="h-4 w-4" />
                                  </Button>
                                )}
                              </div>
                            </TableCell>
                          </TableRow>
                        );
                      })
                    )}
                  </TableBody>
                </Table>
              </CardContent>
            </Card>
          </TabsContent>
        )}

        {/* Info Tab */}
        <TabsContent value="info" className="mt-4">
          <Card>
            <CardContent className="p-6">
              <div className="grid gap-4 sm:grid-cols-2">
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Name</p>
                  <p className="text-sm font-medium">{contact.name}</p>
                </div>
                <div>
                  <p className="text-xs text-muted-foreground mb-1">Type</p>
                  <p className="text-sm font-medium capitalize">{contact.type}</p>
                </div>
                {contact.email && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Email</p>
                    <a href={`mailto:${contact.email}`} className="text-sm text-primary hover:underline">{contact.email}</a>
                  </div>
                )}
                {contact.phone && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Phone</p>
                    <a href={`tel:${contact.phone}`} className="text-sm text-primary hover:underline">{contact.phone}</a>
                  </div>
                )}
                {contact.company && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Company</p>
                    <p className="text-sm font-medium">{contact.company}</p>
                  </div>
                )}
                {contact.tax_id && (
                  <div>
                    <p className="text-xs text-muted-foreground mb-1">Tax ID</p>
                    <p className="text-sm font-medium">{contact.tax_id}</p>
                  </div>
                )}
                <ContactAddressesSection contactId={contactId} />

                {contact.notes && (
                  <div className="sm:col-span-2">
                    <p className="text-xs text-muted-foreground mb-1">Notes</p>
                    <p className="text-sm whitespace-pre-wrap">{contact.notes}</p>
                  </div>
                )}
              </div>
            </CardContent>
          </Card>
        </TabsContent>

        {/* Activity Tab */}
        <TabsContent value="activity" className="mt-4">
          <ContactActivityTimeline
            invoices={profile.invoices}
            bills={profile.bills}
            payments={profile.payments}
            billPayments={profile.billPayments}
            creditNotes={profile.creditNotes}
            salesOrders={profile.salesOrders}
            purchaseOrders={profile.purchaseOrders}
          />
        </TabsContent>

        {/* Hierarchy Tab */}
        <TabsContent value="hierarchy" className="mt-4">
          <Card>
            <CardContent className="p-6 space-y-6">
              {hierarchy.parent && (
                <div>
                  <h3 className="text-sm font-semibold text-muted-foreground mb-2">Parent company</h3>
                  <button
                    className="flex items-center gap-2 text-left hover:underline"
                    onClick={() => navigate(`/contacts-app/profile?id=${hierarchy.parent!.id}`)}
                  >
                    <Building2 className="h-4 w-4" />
                    <span className="font-medium">{hierarchy.parent.name}</span>
                  </button>
                </div>
              )}

              {hierarchy.children.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-muted-foreground mb-2">
                    Contacts at this company ({hierarchy.children.length})
                  </h3>
                  <ul className="divide-y rounded-md border">
                    {hierarchy.children.map((c) => (
                      <li key={c.id}>
                        <button
                          className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/50"
                          onClick={() => navigate(`/contacts-app/profile?id=${c.id}`)}
                        >
                          <span className="font-medium truncate">{c.name}</span>
                          {c.email && <span className="text-xs text-muted-foreground truncate ml-3">{c.email}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {hierarchy.siblings.length > 0 && (
                <div>
                  <h3 className="text-sm font-semibold text-muted-foreground mb-2">
                    Other contacts at {hierarchy.parent?.name ?? "the same company"} ({hierarchy.siblings.length})
                  </h3>
                  <ul className="divide-y rounded-md border">
                    {hierarchy.siblings.map((c) => (
                      <li key={c.id}>
                        <button
                          className="w-full flex items-center justify-between px-3 py-2 text-left hover:bg-muted/50"
                          onClick={() => navigate(`/contacts-app/profile?id=${c.id}`)}
                        >
                          <span className="font-medium truncate">{c.name}</span>
                          {c.email && <span className="text-xs text-muted-foreground truncate ml-3">{c.email}</span>}
                        </button>
                      </li>
                    ))}
                  </ul>
                </div>
              )}

              {!hierarchy.parent && hierarchy.children.length === 0 && hierarchy.siblings.length === 0 && (
                <p className="text-sm text-muted-foreground">
                  This contact is not linked to any commercial hierarchy yet.
                </p>
              )}
            </CardContent>
          </Card>
        </TabsContent>

        {/* Custom Fields Tab */}
        <TabsContent value="custom" className="mt-4">
          <Card>
            <CardContent className="p-6">
              <CustomFieldsSection
                entityType="contact"
                entityId={contactId}
                readOnly
                showHeader={false}
              />
            </CardContent>
          </Card>
        </TabsContent>
      </Tabs>

      {/* Lead Details Dialog */}
      <LeadDetailsDialog
        lead={selectedLead}
        open={showLeadDetails}
        onOpenChange={setShowLeadDetails}
        onDelete={deleteLead}
      />

      {/* Lead Form Dialog */}
      <LeadForm
        open={showLeadForm}
        onOpenChange={setShowLeadForm}
        defaultContactId={contactId}
        defaultContactName={contact?.name}
      />

      {/* Apply-credit is a dedicated wizard route — no dialog mount here. */}
      <CreditNotePeekSheet
        creditNoteId={peekCreditNoteId}
        onOpenChange={(open) => { if (!open) setPeekCreditNoteId(null); }}
      />
    </div>
  );
}
