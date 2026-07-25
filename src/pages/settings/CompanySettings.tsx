import { normalizeError } from "@/services/resilience";
/**
 * Company Settings hub (/settings/company).
 *
 * Phase 3 of the Zero-Trust audit. Every tab here is COMPANY-scoped — it reads
 * and writes data tied to a specific `business_id`. The whole page is wrapped
 * in `<CompanyScopeGate>` so it refuses to render in a multi-company workspace
 * unless a Company is actively selected. The page header always shows the
 * active Company chip so accountants can never edit the wrong books.
 *
 * Workspace-level chrome (Profile, Appearance, Notifications, Security, Access
 * Groups, Localization, Data) lives under /settings/workspace.
 */
import { useEffect, useState } from "react";
import { useSearchParams, Link } from "react-router-dom";
import { PlatformAppLayout } from "@/apps/platform";
import { useSession } from "@/contexts/SessionContext";
import { useOrganization } from "@/hooks/useOrganization";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { useToast } from "@/hooks/use-toast";
import {
  Loader2,
  Building2,
  Coins,
  Percent,
  CreditCard,
  Store,
  Calendar,
  Mail,
  FileCheck,
  Receipt,
  FileText,
  Wallet,
  Printer,
  ArrowLeft,
  Mail as MailIcon,
  Package,
  History,
} from "lucide-react";
import { SettingsAuditLogPanel } from "@/components/settings/SettingsAuditLogPanel";
import { CurrencySettings } from "@/components/settings/CurrencySettings";
import { TaxSettings } from "@/components/settings/TaxSettings";
import { PaymentGatewaySettings } from "@/components/settings/PaymentGatewaySettings";
import { MpesaProviderCard } from "@/components/settings/MpesaProviderCard";
import { MpesaC2BProviderCard } from "@/components/settings/MpesaC2BProviderCard";
import { BusinessBranchSettings } from "@/components/settings/BusinessBranchSettings";
import { PaymentTermsSettings } from "@/components/settings/PaymentTermsSettings";
import { TaxComplianceSettings } from "@/components/settings/TaxComplianceSettings";
import { ReceiptSettings } from "@/components/settings/ReceiptSettings";
import { PaymentsDebugger } from "@/components/settings/PaymentsDebugger";
import { EmailTemplateEditor } from "@/components/settings/EmailTemplateEditor";
import { DocumentTemplateSettings } from "@/components/settings/DocumentTemplateSettings";
import { PrintingSettings } from "@/components/settings/PrintingSettings";
import { PaymentMethodsSettings } from "@/components/settings/PaymentMethodsSettings";
import { InventorySettings } from "@/components/settings/InventorySettings";
import { ScopeChip } from "@/components/settings/ScopeChip";
import { CompanyScopeGate } from "@/components/reports/CompanyScopeGate";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useInstalledApps } from "@/hooks/useInstalledApps";

function CompanySettingsInner() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const permissions = usePermissions();
  const { userType } = useSession();
  // eslint-disable-next-line local/no-raw-installed-apps-loading-gate -- decoration: not used for redirect/gating
  const { isInstalled, isLoading: appsLoading } = useInstalledApps();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortalUser = userType === "portal";

  const activeTab = searchParams.get("tab") || "company";

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value }, { replace: true });
  };

  const canEditOrg = permissions.canManageOrganization;
  const orgCountry = currentBusiness?.country || "";

  // Per-app tab visibility. While the install list loads we default to
  // showing tabs (avoids a flash-of-missing-tabs); once loaded we hide the
  // tab entirely if the consuming app is not installed. This is the
  // Odoo-style behavior — settings for uninstalled apps simply don't exist
  // in the UI. Read-only / expired-trial lifecycle states still SHOW the
  // tab; the inputs inside enforce edit-disabled via per-form gates.
  const hasFinance = appsLoading || isInstalled("finance");
  const hasSales = appsLoading || isInstalled("sales");
  const hasPos = appsLoading || isInstalled("pos");
  const hasDocuments = appsLoading || isInstalled("finance");

  return (
    <PlatformAppLayout>
      <div className="space-y-6 sm:space-y-8">
        <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
          <div>
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="page-title">Company settings</h1>
              <ScopeChip scope="company" />
              {currentBusiness && (
                <span className="inline-flex items-center gap-1.5 rounded-full bg-primary/10 px-2.5 py-1 text-xs font-medium text-primary">
                  <Building2 className="h-3 w-3" />
                  {currentBusiness.name}
                </span>
              )}
            </div>
            <p className="text-sm sm:text-base text-muted-foreground">
              Settings for the active company's books and documents.
            </p>
          </div>
          <Button asChild variant="outline" size="sm" className="shrink-0">
            <Link to="/settings/workspace">
              <ArrowLeft className="h-3 w-3 mr-1" />
              Workspace settings
            </Link>
          </Button>
        </div>

        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4 sm:space-y-6">
          <div className="-mx-3 sm:mx-0 px-3 sm:px-0 overflow-x-auto scrollbar-hide">
            <TabsList className="inline-flex h-auto gap-1 p-1 w-max sm:w-full sm:flex-wrap sm:justify-start">
              {!isPortalUser && permissions.canManageBusiness && (
                <TabsTrigger value="company" className="gap-1.5 text-xs sm:text-sm">
                  <Store className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Company &amp; Branches</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageCurrency && (
                <TabsTrigger value="currency" className="gap-1.5 text-xs sm:text-sm">
                  <Coins className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Currency</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageTaxSettings && hasFinance && (
                <TabsTrigger value="tax" className="gap-1.5 text-xs sm:text-sm">
                  <Percent className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Tax</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canEditSettings && (hasFinance || hasSales) && (
                <TabsTrigger value="payment-terms" className="gap-1.5 text-xs sm:text-sm">
                  <Calendar className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Terms</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManagePaymentGateways && (hasFinance || hasSales) && (
                <TabsTrigger value="payments" className="gap-1.5 text-xs sm:text-sm">
                  <CreditCard className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Payments</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canEditSettings && (hasFinance || hasSales) && (
                <TabsTrigger value="payment-methods" className="gap-1.5 text-xs sm:text-sm">
                  <Wallet className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Pay Methods</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageEmailSettings && (
                <TabsTrigger value="email" className="gap-1.5 text-xs sm:text-sm">
                  <Mail className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Email</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageTaxSettings && hasFinance && (
                <TabsTrigger value="tax-compliance" className="gap-1.5 text-xs sm:text-sm">
                  <FileCheck className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Compliance</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canEditSettings && hasPos && (
                <TabsTrigger value="receipts" className="gap-1.5 text-xs sm:text-sm">
                  <Receipt className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Receipts</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canEditSettings && hasDocuments && (
                <TabsTrigger value="templates" className="gap-1.5 text-xs sm:text-sm">
                  <FileText className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Templates</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageBusiness && (
                <TabsTrigger value="printing" className="gap-1.5 text-xs sm:text-sm">
                  <Printer className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Printing</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageBusiness && (
                <TabsTrigger value="inventory" className="gap-1.5 text-xs sm:text-sm">
                  <Package className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Inventory</span>
                </TabsTrigger>
              )}
              {/* Audit log surfaced centrally at /settings/audit-logs?tab=settings */}

            </TabsList>
          </div>

          <TabsContent value="company">
            <BusinessBranchSettings />
          </TabsContent>

          <TabsContent value="currency">
            <CurrencySettings />
          </TabsContent>

          <TabsContent value="tax">
            <TaxSettings />
          </TabsContent>

          <TabsContent value="payment-terms">
            <PaymentTermsSettings />
          </TabsContent>

          <TabsContent value="payments" className="space-y-6">
            {["KE", "TZ", "UG", "RW", "MZ", "GH"].includes(orgCountry) && (
              <>
                <MpesaProviderCard />
                <MpesaC2BProviderCard />
              </>
            )}
            <PaymentGatewaySettings />
            <PaymentsDebugger />
          </TabsContent>

          <TabsContent value="tax-compliance">
            <TaxComplianceSettings />
          </TabsContent>

          <TabsContent value="receipts">
            <ReceiptSettings />
          </TabsContent>

          <TabsContent value="templates">
            <DocumentTemplateSettings />
          </TabsContent>

          <TabsContent value="printing">
            <PrintingSettings />
          </TabsContent>

          <TabsContent value="payment-methods">
            <PaymentMethodsSettings />
          </TabsContent>

          <TabsContent value="email" className="space-y-6">
            <Card>
              <CardHeader>
                <CardTitle>Email Identity</CardTitle>
                <CardDescription>
                  How this company appears in outgoing emails. Sent from the platform's verified domain for reliable delivery.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <EmailSettingsForm businessId={currentBusiness?.id} canEdit={canEditOrg} />
              </CardContent>
            </Card>
            <EmailTemplateEditor />
          </TabsContent>

          <TabsContent value="inventory">
            <InventorySettings />
          </TabsContent>



        </Tabs>
      </div>
    </PlatformAppLayout>
  );
}

export default function CompanySettings() {
  return (
    <CompanyScopeGate reportName="Company settings">
      <CompanySettingsInner />
    </CompanyScopeGate>
  );
}

function EmailSettingsForm({ businessId, canEdit }: { businessId?: string; canEdit: boolean }) {
  const { toast } = useToast();
  const [emailDisplayName, setEmailDisplayName] = useState("");
  const [emailReplyTo, setEmailReplyTo] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    if (businessId) {
      fetchEmailSettings();
    } else {
      setIsLoading(false);
    }
  }, [businessId]);

  const fetchEmailSettings = async () => {
    if (!businessId) return;
    setIsLoading(true);
    try {
      const { data, error } = await supabase
        .from("businesses")
        .select("email_display_name, email_reply_to")
        .eq("id", businessId)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        setEmailDisplayName((data as any).email_display_name || "");
        setEmailReplyTo((data as any).email_reply_to || "");
      }
    } catch (error) {
      console.error("Error fetching email settings:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!businessId || !canEdit) {
      if (!businessId) {
        toast({
          title: "Select a Company first",
          description: "Email identity is per-company.",
          variant: "destructive",
        });
      }
      return;
    }
    setIsSaving(true);
    try {
      const { error } = await supabase
        .from("businesses")
        .update({
          email_display_name: emailDisplayName || null,
          email_reply_to: emailReplyTo || null,
        } as any)
        .eq("id", businessId);
      if (error) throw error;
      toast({ title: "Email settings saved", description: "Your email display settings have been updated." });
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to save email settings",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <form onSubmit={handleSave} className="space-y-4 max-w-md">
      <div className="space-y-2">
        <Label htmlFor="emailDisplayName">Display Name</Label>
        <Input
          id="emailDisplayName"
          value={emailDisplayName}
          onChange={(e) => setEmailDisplayName(e.target.value)}
          placeholder="e.g., Acme Corporation Ltd"
          disabled={!canEdit}
        />
        <p className="text-xs text-muted-foreground">
          Sender name on outgoing emails (invoices, receipts, statements).
        </p>
      </div>
      <div className="space-y-2">
        <Label htmlFor="emailReplyTo">Reply-To Email</Label>
        <Input
          id="emailReplyTo"
          type="email"
          value={emailReplyTo}
          onChange={(e) => setEmailReplyTo(e.target.value)}
          placeholder="e.g., billing@yourcompany.com"
          disabled={!canEdit}
        />
        <p className="text-xs text-muted-foreground">
          Where recipients reply when they respond to this company's emails.
        </p>
      </div>
      <div className="rounded-lg bg-muted/50 p-3 text-sm text-muted-foreground">
        <p className="flex items-center gap-2">
          <MailIcon className="h-4 w-4" />
          Emails are sent from the platform's verified domain for reliable delivery.
        </p>
      </div>
      {canEdit && (
        <Button type="submit" disabled={isSaving}>
          {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
          Save Email Settings
        </Button>
      )}
    </form>
  );
}
