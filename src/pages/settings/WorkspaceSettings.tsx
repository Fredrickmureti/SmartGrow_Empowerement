import { normalizeError } from "@/services/resilience";
/**
 * Workspace Settings hub (/settings/workspace).
 *
 * Phase 3 of the Zero-Trust audit: the Settings page was split from a single
 * 17-tab monolith into two clearly-labelled hubs so accountants can never
 * accidentally edit company-scoped accounting config (tax, currency, payment
 * methods, prefixes) thinking they were editing workspace chrome.
 *
 *   /settings/workspace  ← THIS FILE — organization scope (workspace chrome)
 *     Profile · Appearance · Workspace · Notifications · Security ·
 *     Access Groups · Localization · Data
 *
 *   /settings/company    ← CompanySettings.tsx — business scope (legal entity)
 *     Company Profile · Branches · Currency · Tax · Payment Terms ·
 *     Payment Methods · Payment Gateways · Email · Receipts · Templates ·
 *     Tax Compliance
 *
 * Every tab here is workspace-wide and does NOT depend on `currentBusiness`.
 * If you find yourself reaching for `business_id` here, the tab belongs in
 * CompanySettings instead.
 */
import { useEffect, useState } from "react";
import { useSearchParams } from "react-router-dom";
import { PlatformAppLayout } from "@/apps/platform";
import { useSession } from "@/contexts/SessionContext";
import { useOrganization } from "@/hooks/useOrganization";
import { useAuth } from "@/contexts/AuthContext";
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
  User,
  Palette,
  Bell,
  Shield,
  Database,
  Users,
  Globe,
  ArrowRight,
  DatabaseZap,
  AppWindow,
  Image as ImageIcon,
} from "lucide-react";

import { OrgDataResetTool } from "@/components/settings/OrgDataResetTool";
import { SelfActionPolicy } from "@/components/settings/SelfActionPolicy";
import { GovernanceModeCard } from "@/components/settings/GovernanceModeCard";
import { BlockedAttemptsQueue } from "@/components/settings/BlockedAttemptsQueue";
import { ResetWorkspaceDialog } from "@/components/settings/ResetWorkspaceDialog";
import { BrandedLoader } from "@/components/common/BrandedLoader";
import { ThemeSettings } from "@/components/settings/ThemeSettings";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { EnhancedNotificationSettings } from "@/components/notifications/EnhancedNotificationSettings";
import { SecuritySettings } from "@/components/settings/SecuritySettings";
import AccessGroups from "@/pages/settings/AccessGroups";
import { ScopeChip } from "@/components/settings/ScopeChip";
import { Link } from "react-router-dom";

export default function WorkspaceSettings() {
  const { user } = useAuth();
  const { currentOrg, refreshOrganizations } = useOrganization();
  const { toast } = useToast();
  const permissions = usePermissions();
  const { userType } = useSession();
  const [searchParams, setSearchParams] = useSearchParams();
  const isPortalUser = userType === "portal";

  const activeTab = searchParams.get("tab") || "profile";

  const handleTabChange = (value: string) => {
    setSearchParams({ tab: value }, { replace: true });
  };

  // Profile state
  const [fullName, setFullName] = useState("");
  const [phone, setPhone] = useState("");
  const [isLoadingProfile, setIsLoadingProfile] = useState(true);
  const [isSavingProfile, setIsSavingProfile] = useState(false);

  // Workspace state
  const [orgName, setOrgName] = useState("");
  const [isSavingOrg, setIsSavingOrg] = useState(false);

  const canEditOrg = permissions.canManageOrganization;

  useEffect(() => {
    fetchProfile();
  }, [user]);

  useEffect(() => {
    if (currentOrg) {
      setOrgName(currentOrg.name);
    }
  }, [currentOrg]);

  const fetchProfile = async () => {
    if (!user) return;
    setIsLoadingProfile(true);
    try {
      const { data, error } = await supabase
        .from("profiles")
        .select("full_name, phone")
        .eq("user_id", user.id)
        .maybeSingle();
      if (error) throw error;
      if (data) {
        setFullName(data.full_name || "");
        setPhone(data.phone || "");
      }
    } catch (error) {
      console.error("Error fetching profile:", error);
    } finally {
      setIsLoadingProfile(false);
    }
  };

  const handleSaveProfile = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setIsSavingProfile(true);
    try {
      const { error } = await supabase
        .from("profiles")
        .update({ full_name: fullName, phone })
        .eq("user_id", user.id);
      if (error) throw error;
      toast({ title: "Profile updated", description: "Your profile has been saved" });
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update profile",
        variant: "destructive",
      });
    } finally {
      setIsSavingProfile(false);
    }
  };

  const handleSaveOrg = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !canEditOrg) return;
    setIsSavingOrg(true);
    try {
      const { error: orgError } = await supabase
        .from("organizations")
        .update({ name: orgName })
        .eq("id", currentOrg.id);
      if (orgError) throw orgError;
      toast({ title: "Workspace updated", description: "Workspace name saved" });
      refreshOrganizations();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to update workspace",
        variant: "destructive",
      });
    } finally {
      setIsSavingOrg(false);
    }
  };

  if (isLoadingProfile) {
    return (
      <PlatformAppLayout>
        <BrandedLoader message="Loading workspace settings..." fullScreen={false} />
      </PlatformAppLayout>
    );
  }

  return (
    <PlatformAppLayout>
      <div className="space-y-6 sm:space-y-8">
        <div className="flex flex-col @2xl/page:flex-row @2xl/page:items-end @2xl/page:justify-between gap-3">
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <h1 className="page-title">Workspace settings</h1>
              <ScopeChip scope="workspace" />
            </div>
            <p className="text-sm sm:text-base text-muted-foreground">
              Settings that apply to the entire workspace and every company in it.
            </p>
          </div>
          {/* Cross-links to other admin hubs — hidden for portal users so
              employees don't get drawn into Apps & Subscriptions or Company
              admin surfaces from a settings page that legitimately lets them
              edit their own profile / notifications. */}
          {!isPortalUser && (
            <div className="flex flex-wrap items-center gap-2 w-full @2xl/page:w-auto min-w-0">
              <Button asChild variant="outline" size="sm" className="min-w-0 flex-1 @xs/page:flex-none justify-center">
                <Link to="/settings/apps">
                  <AppWindow className="h-4 w-4 mr-1.5 shrink-0" />
                  <span className="truncate">Apps & Subscriptions</span>
                  <ArrowRight className="h-3 w-3 ml-1 shrink-0" />
                </Link>
              </Button>
              <Button asChild variant="outline" size="sm" className="min-w-0 flex-1 @xs/page:flex-none justify-center">
                <Link to="/settings/company">
                  <Building2 className="h-4 w-4 mr-1.5 shrink-0" />
                  <span className="truncate">Company settings</span>
                  <ArrowRight className="h-3 w-3 ml-1 shrink-0" />
                </Link>
              </Button>
            </div>
          )}
        </div>


        <Tabs value={activeTab} onValueChange={handleTabChange} className="space-y-4 sm:space-y-6">
          <div className="-mx-3 sm:mx-0 px-3 sm:px-0 overflow-x-auto scrollbar-hide">
            <TabsList className="inline-flex h-auto gap-1 p-1 w-max sm:w-full sm:flex-wrap sm:justify-start">
              <TabsTrigger value="profile" className="gap-1.5 text-xs sm:text-sm">
                <User className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Profile</span>
              </TabsTrigger>
              <TabsTrigger value="appearance" className="gap-1.5 text-xs sm:text-sm">
                <Palette className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Appearance</span>
              </TabsTrigger>
              {!isPortalUser && permissions.canManageOrganization && (
                <TabsTrigger value="workspace" className="gap-1.5 text-xs sm:text-sm">
                  <Globe className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Workspace</span>
                </TabsTrigger>
              )}
              <TabsTrigger value="notifications" className="gap-1.5 text-xs sm:text-sm">
                <Bell className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Notifications</span>
              </TabsTrigger>
              <TabsTrigger value="security" className="gap-1.5 text-xs sm:text-sm">
                <Shield className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <span className="hidden sm:inline">Security</span>
              </TabsTrigger>
              {!isPortalUser && permissions.canManageTeam && (
                <TabsTrigger value="access-groups" className="gap-1.5 text-xs sm:text-sm">
                  <Users className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Access Groups</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageOrganization && (
                <TabsTrigger value="localization" className="gap-1.5 text-xs sm:text-sm">
                  <Globe className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Localization</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageOrganization && (
                <TabsTrigger value="governance" className="gap-1.5 text-xs sm:text-sm">
                  <Shield className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Governance</span>
                </TabsTrigger>
              )}
              {!isPortalUser && permissions.canManageOrganization && (
                <TabsTrigger value="data" className="gap-1.5 text-xs sm:text-sm">
                  <Database className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  <span className="hidden sm:inline">Data</span>
                </TabsTrigger>
              )}
            </TabsList>
          </div>

          <TabsContent value="profile">
            <Card>
              <CardHeader>
                <CardTitle>Profile</CardTitle>
                <CardDescription>Your personal information.</CardDescription>
              </CardHeader>
              <CardContent>
                <form onSubmit={handleSaveProfile} className="space-y-4 max-w-md">
                  <div className="space-y-2">
                    <Label htmlFor="email">Email</Label>
                    <Input id="email" type="email" value={user?.email || ""} disabled className="bg-muted" />
                    <p className="text-xs text-muted-foreground">Email cannot be changed</p>
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="fullName">Full Name</Label>
                    <Input
                      id="fullName"
                      value={fullName}
                      onChange={(e) => setFullName(e.target.value)}
                      placeholder="John Doe"
                    />
                  </div>
                  <div className="space-y-2">
                    <Label htmlFor="phone">Phone</Label>
                    <Input
                      id="phone"
                      value={phone}
                      onChange={(e) => setPhone(e.target.value)}
                      placeholder="+1 (555) 000-0000"
                    />
                  </div>
                  <Button type="submit" disabled={isSavingProfile}>
                    {isSavingProfile && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                    Save Changes
                  </Button>
                </form>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="appearance">
            <ThemeSettings />
          </TabsContent>

          <TabsContent value="workspace">
            <Card>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle>Workspace</CardTitle>
                    <CardDescription>
                      {canEditOrg
                        ? "Workspace name and shared branding. Per-company identity (legal name, tax ID, address, prefixes, fiscal year) lives under Company settings."
                        : "Workspace overview (read-only)."}
                    </CardDescription>
                  </div>
                  <ScopeChip scope="workspace" />
                </div>
              </CardHeader>
              <CardContent className="space-y-6">
                {/* Logos are per-company (Odoo res.company model). Workspace
                    has no logo — direct users to Company settings. */}
                <Alert>
                  <ImageIcon className="h-4 w-4" />
                  <AlertDescription className="flex flex-col gap-1">
                    <span>
                      Logos are per-company. Each company has its own logo that appears on its invoices, bills, receipts, and statements.
                    </span>
                    <Link
                      to="/settings/company?tab=company"
                      className="text-primary hover:underline text-sm font-medium"
                    >
                      Manage company logos in Company settings →
                    </Link>
                  </AlertDescription>
                </Alert>

                <div className="border-t pt-6">
                  <form onSubmit={handleSaveOrg} className="space-y-4 max-w-md">
                    <div className="space-y-2">
                      <Label htmlFor="orgName">Workspace Name</Label>
                      <Input
                        id="orgName"
                        value={orgName}
                        onChange={(e) => setOrgName(e.target.value)}
                        disabled={!canEditOrg}
                      />
                      <p className="text-xs text-muted-foreground">
                        The workspace name shown across the platform. Not used on invoices or other documents — those use the Company's legal name.
                      </p>
                    </div>
                    {canEditOrg && (
                      <Button type="submit" disabled={isSavingOrg}>
                        {isSavingOrg && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                        Save Changes
                      </Button>
                    )}
                  </form>
                </div>

                <Alert>
                  <Building2 className="h-4 w-4" />
                  <AlertDescription className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                    <span className="text-sm">
                      Looking for legal name, tax ID, address, fiscal year, or invoice prefixes? Those live on each Company.
                    </span>
                    <Button asChild variant="outline" size="sm" className="shrink-0">
                      <Link to="/settings/company">
                        Open Company settings
                        <ArrowRight className="ml-1 h-3 w-3" />
                      </Link>
                    </Button>
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="notifications">
            <EnhancedNotificationSettings />
          </TabsContent>

          <TabsContent value="security">
            <SecuritySettings />
          </TabsContent>

          {permissions.canManageTeam && (
            <TabsContent value="access-groups">
              <AccessGroups />
            </TabsContent>
          )}


          {permissions.canManageOrganization && (
            <TabsContent value="governance" className="space-y-6">
              <GovernanceModeCard />
              <SelfActionPolicy />
              <BlockedAttemptsQueue />
            </TabsContent>
          )}

          <TabsContent value="data" className="space-y-6">
            <Card className="border-primary/20">
              <CardHeader>
                <div className="flex items-center gap-3">
                  <div className="flex h-10 w-10 items-center justify-center rounded-lg bg-primary/10">
                    <DatabaseZap className="h-5 w-5 text-primary" />
                  </div>
                  <div>
                    <CardTitle>Data Migration</CardTitle>
                    <CardDescription>
                      Import financial data from another accounting system with guided validation.
                    </CardDescription>
                  </div>
                </div>
              </CardHeader>
              <CardContent>
                <p className="text-sm text-muted-foreground mb-4">
                  Migrate your chart of accounts, trial balance, open AR/AP, bank balances, and
                  inventory from QuickBooks, Odoo, Xero, Tally, or any CSV/XLSX export.
                </p>
                <Button onClick={() => (window.location.href = "/settings/migration")} className="gap-2">
                  Open Migration Workbench
                  <ArrowRight className="h-4 w-4" />
                </Button>
              </CardContent>
            </Card>


            <OrgDataResetTool />
            <ResetWorkspaceDialog />
          </TabsContent>
        </Tabs>
      </div>
    </PlatformAppLayout>
  );
}
