import { useState, useEffect } from "react";
import { AdminMfaStatus } from "@/components/admin/AdminMfaStatus";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { DemoVideoManagement } from "@/components/admin/DemoVideoManagement";
import { AuthEmailTemplates } from "@/components/admin/AuthEmailTemplates";
import { SentrySettings } from "@/components/admin/SentrySettings";
import { DataResetTool } from "@/components/admin/DataResetTool";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import {
  Settings,
  Shield,
  Globe,
  Database,
  Bell,
  Lock,
  Server,
  Loader2,
  Video,
  FileText,
  Activity,
} from "lucide-react";

export default function AdminSettings() {
  const { settings, isLoading, isSaving, getSetting, updateSetting, updateMultipleSettings } = usePlatformSettings();
  
  const [maintenanceMode, setMaintenanceMode] = useState(false);
  const [emailNotifications, setEmailNotifications] = useState(true);

  // Security tab state — bound to platform_settings rows seeded by migration
  const [allowNewSignups, setAllowNewSignups] = useState(true);
  const [requireEmailVerification, setRequireEmailVerification] = useState(true);
  const [sessionTimeoutMinutes, setSessionTimeoutMinutes] = useState<string>("30");
  const [passwordMinLength, setPasswordMinLength] = useState<string>("8");
  const [passwordRequireUppercase, setPasswordRequireUppercase] = useState(true);
  const [passwordRequireNumber, setPasswordRequireNumber] = useState(true);
  // Operator-level (platform-wide) policy: when false, no admin can use a
  // PIN to log in. The personal PIN UI lives in /admin-management/profile,
  // but the *policy* belongs in Settings → Security so the platform owner
  // can lock it down for the entire admin population in one place.
  const [allowAdminPinLogin, setAllowAdminPinLogin] = useState(true);

  const [platformName, setPlatformName] = useState("");
  const [supportEmail, setSupportEmail] = useState("");
  const [websiteUrl, setWebsiteUrl] = useState("");
  const [platformLogoUrl, setPlatformLogoUrl] = useState("");

  useEffect(() => {
    if (settings.length > 0) {
      setPlatformName(getSetting("platform_name") || "");
      setSupportEmail(getSetting("support_email") || "");
      setWebsiteUrl(getSetting("website_url") || "");
      setPlatformLogoUrl(getSetting("platform_logo_url") || "");
      setMaintenanceMode(getSetting("maintenance_mode") === "true");
      // Security defaults preserve previous behaviour when row is missing.
      setAllowNewSignups((getSetting("allow_new_signups") ?? "true") === "true");
      setRequireEmailVerification(
        (getSetting("require_email_verification") ?? "true") === "true",
      );
      setSessionTimeoutMinutes(getSetting("session_timeout_minutes") ?? "30");
      setPasswordMinLength(getSetting("password_min_length") ?? "8");
      setPasswordRequireUppercase(
        (getSetting("password_require_uppercase") ?? "true") === "true",
      );
      setPasswordRequireNumber(
        (getSetting("password_require_number") ?? "true") === "true",
      );
      setAllowAdminPinLogin(
        (getSetting("allow_admin_pin_login") ?? "true") === "true",
      );
    }
  }, [settings]);

  const handleSaveGeneral = async () => {
    await updateMultipleSettings([
      { key: "platform_name", value: platformName },
      { key: "support_email", value: supportEmail },
      { key: "website_url", value: websiteUrl },
      { key: "platform_logo_url", value: platformLogoUrl },
    ]);
  };

  const handleMaintenanceModeChange = async (enabled: boolean) => {
    setMaintenanceMode(enabled);
    await updateSetting("maintenance_mode", enabled ? "true" : "false");
  };

  const handleAllowSignupsChange = async (v: boolean) => {
    setAllowNewSignups(v);
    await updateSetting("allow_new_signups", v ? "true" : "false");
  };

  const handleEmailVerificationChange = async (v: boolean) => {
    setRequireEmailVerification(v);
    await updateSetting("require_email_verification", v ? "true" : "false");
  };

  const handleSavePasswordPolicy = async () => {
    await updateMultipleSettings([
      { key: "password_min_length", value: passwordMinLength },
      { key: "password_require_uppercase", value: passwordRequireUppercase ? "true" : "false" },
      { key: "password_require_number", value: passwordRequireNumber ? "true" : "false" },
    ]);
  };

  const handleSaveSessionTimeout = async () => {
    await updateSetting("session_timeout_minutes", sessionTimeoutMinutes);
  };

  const handleAllowAdminPinLoginChange = async (v: boolean) => {
    setAllowAdminPinLogin(v);
    await updateSetting("allow_admin_pin_login", v ? "true" : "false");
  };

  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold tracking-tight">Platform Settings</h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            General configuration, security, content, and system settings
          </p>
        </div>

        <Tabs defaultValue="general" className="space-y-4 sm:space-y-6">
          <div className="overflow-x-auto scrollbar-hide -mx-3 px-3 sm:-mx-0 sm:px-0 pb-1">
            <TabsList className="inline-flex w-max gap-0.5 h-auto p-0.5 sm:p-1">
              <TabsTrigger value="general" className="flex items-center gap-1 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1 sm:px-2.5 sm:py-1.5 lg:px-3 lg:py-2 whitespace-nowrap">
                <Settings className="h-3 w-3 sm:h-3.5 sm:w-3.5 hidden sm:block" />
                General
              </TabsTrigger>
              <TabsTrigger value="security" className="flex items-center gap-1 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1 sm:px-2.5 sm:py-1.5 lg:px-3 lg:py-2 whitespace-nowrap">
                <Shield className="h-3 w-3 sm:h-3.5 sm:w-3.5 hidden sm:block" />
                Security
              </TabsTrigger>
              <TabsTrigger value="auth-templates" className="flex items-center gap-1 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1 sm:px-2.5 sm:py-1.5 lg:px-3 lg:py-2 whitespace-nowrap">
                <FileText className="h-3 w-3 sm:h-3.5 sm:w-3.5 hidden sm:block" />
                Auth
              </TabsTrigger>
              <TabsTrigger value="content" className="flex items-center gap-1 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1 sm:px-2.5 sm:py-1.5 lg:px-3 lg:py-2 whitespace-nowrap">
                <Video className="h-3 w-3 sm:h-3.5 sm:w-3.5 hidden sm:block" />
                Content
              </TabsTrigger>
              <TabsTrigger value="monitoring" className="flex items-center gap-1 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1 sm:px-2.5 sm:py-1.5 lg:px-3 lg:py-2 whitespace-nowrap">
                <Activity className="h-3 w-3 sm:h-3.5 sm:w-3.5 hidden sm:block" />
                Monitor
              </TabsTrigger>
              <TabsTrigger value="system" className="flex items-center gap-1 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1 sm:px-2.5 sm:py-1.5 lg:px-3 lg:py-2 whitespace-nowrap">
                <Server className="h-3 w-3 sm:h-3.5 sm:w-3.5 hidden sm:block" />
                System
              </TabsTrigger>
            </TabsList>
          </div>

          {/* General Settings Tab */}
          <TabsContent value="general" className="space-y-4 sm:space-y-6">
            <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <Globe className="h-4 w-4 sm:h-5 sm:w-5" />
                    Platform Information
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">
                    Basic platform configuration visible to users
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 sm:space-y-4 p-4 sm:p-6 pt-0 sm:pt-0">
                  {isLoading ? (
                    <div className="flex items-center justify-center py-4">
                      <Loader2 className="h-5 w-5 sm:h-6 sm:w-6 animate-spin text-muted-foreground" />
                    </div>
                  ) : (
                    <>
                      <div className="space-y-1.5 sm:space-y-2">
                        <Label htmlFor="platform-name" className="text-xs sm:text-sm">Platform Name</Label>
                        <Input id="platform-name" value={platformName} onChange={(e) => setPlatformName(e.target.value)} className="text-sm" />
                      </div>
                      <div className="space-y-1.5 sm:space-y-2">
                        <Label htmlFor="support-email" className="text-xs sm:text-sm">Support Email</Label>
                        <Input id="support-email" type="email" value={supportEmail} onChange={(e) => setSupportEmail(e.target.value)} className="text-sm" />
                      </div>
                      <div className="space-y-1.5 sm:space-y-2">
                        <Label htmlFor="website" className="text-xs sm:text-sm">Website URL</Label>
                        <Input id="website" value={websiteUrl} onChange={(e) => setWebsiteUrl(e.target.value)} className="text-sm" />
                      </div>
                      <div className="space-y-1.5 sm:space-y-2">
                        <Label htmlFor="platform-logo" className="text-xs sm:text-sm">Platform Logo URL</Label>
                        <Input id="platform-logo" placeholder="https://example.com/logo.png" value={platformLogoUrl} onChange={(e) => setPlatformLogoUrl(e.target.value)} className="text-sm" />
                        {platformLogoUrl && (
                          <div className="mt-2 p-2 border rounded-md bg-muted/30 inline-block">
                            <img src={platformLogoUrl} alt="Platform logo preview" className="h-8 max-w-[160px] object-contain" onError={(e) => { (e.target as HTMLImageElement).style.display = 'none'; }} />
                          </div>
                        )}
                      </div>
                      <Button className="mt-3 sm:mt-4 w-full sm:w-auto text-xs sm:text-sm" size="sm" onClick={handleSaveGeneral} disabled={isSaving}>
                        {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        Save Changes
                      </Button>
                    </>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <Bell className="h-4 w-4 sm:h-5 sm:w-5" />
                    Notifications
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">
                    Configure platform notification settings
                  </CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 sm:space-y-6 p-4 sm:p-6 pt-0 sm:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <Label className="text-xs sm:text-sm">Email Notifications</Label>
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Send system emails to users</p>
                    </div>
                    <Switch checked={emailNotifications} onCheckedChange={setEmailNotifications} />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <Label className="text-xs sm:text-sm">Admin Alerts</Label>
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Receive alerts for critical events</p>
                    </div>
                    <Switch defaultChecked />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <Label className="text-xs sm:text-sm">Weekly Reports</Label>
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Email weekly platform summary</p>
                    </div>
                    <Switch />
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Security Tab */}
          <TabsContent value="security" className="space-y-4 sm:space-y-6">
            <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <Shield className="h-4 w-4 sm:h-5 sm:w-5" />
                    Security Settings
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">Platform security configuration</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 sm:space-y-6 p-4 sm:p-6 pt-0 sm:pt-0">
                  <AdminMfaStatus />
                  <Separator />
                  {/* Session timeout — bound to platform_settings.session_timeout_minutes
                      and consumed by useInactivityMonitor. */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5 min-w-0">
                        <Label htmlFor="session-timeout" className="text-xs sm:text-sm">Session Timeout (minutes)</Label>
                        <p className="text-[11px] sm:text-sm text-muted-foreground">Auto-logout after inactivity</p>
                      </div>
                      <Input
                        id="session-timeout"
                        type="number"
                        min={1}
                        max={1440}
                        value={sessionTimeoutMinutes}
                        onChange={(e) => setSessionTimeoutMinutes(e.target.value)}
                        className="w-24 text-sm"
                      />
                    </div>
                    <div className="flex justify-end">
                      <Button size="sm" variant="outline" onClick={handleSaveSessionTimeout} disabled={isSaving}>
                        {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        Save
                      </Button>
                    </div>
                  </div>
                  <Separator />
                  {/* Password policy — applied at signup and password change. */}
                  <div className="space-y-3">
                    <div className="space-y-0.5">
                      <Label className="text-xs sm:text-sm">Password Requirements</Label>
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Minimum password complexity</p>
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <Label htmlFor="pw-min" className="text-xs">Minimum length</Label>
                      <Input
                        id="pw-min"
                        type="number"
                        min={6}
                        max={64}
                        value={passwordMinLength}
                        onChange={(e) => setPasswordMinLength(e.target.value)}
                        className="w-24 text-sm"
                      />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-xs">Require uppercase letter</Label>
                      <Switch checked={passwordRequireUppercase} onCheckedChange={setPasswordRequireUppercase} />
                    </div>
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-xs">Require number</Label>
                      <Switch checked={passwordRequireNumber} onCheckedChange={setPasswordRequireNumber} />
                    </div>
                    <div className="flex justify-end">
                      <Button size="sm" variant="outline" onClick={handleSavePasswordPolicy} disabled={isSaving}>
                        {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                        Save Policy
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <Lock className="h-4 w-4 sm:h-5 sm:w-5" />
                    Access Control
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">Manage platform access settings</CardDescription>
                </CardHeader>
                <CardContent className="space-y-4 sm:space-y-6 p-4 sm:p-6 pt-0 sm:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <Label className="text-xs sm:text-sm">Allow New Signups</Label>
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Enable public registration</p>
                    </div>
                    <Switch checked={allowNewSignups} onCheckedChange={handleAllowSignupsChange} disabled={isSaving} />
                  </div>
                  <Separator />
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <Label className="text-xs sm:text-sm">Email Verification</Label>
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Require email verification</p>
                    </div>
                    <Switch checked={requireEmailVerification} onCheckedChange={handleEmailVerificationChange} disabled={isSaving} />
                  </div>
                  <Separator />
                  {/* Operator-level PIN policy. Personal PIN setup lives in
                      /admin-management/profile (Security tab); this toggle
                      lets the platform owner disable PIN login for ALL
                      admins in one place. */}
                  <div className="space-y-2">
                    <div className="flex items-center justify-between gap-3">
                      <div className="space-y-0.5 min-w-0">
                        <Label className="text-xs sm:text-sm">Allow admin PIN login</Label>
                        <p className="text-[11px] sm:text-sm text-muted-foreground">
                          When off, all platform admins must sign in with a password every time.
                        </p>
                      </div>
                      <Switch
                        checked={allowAdminPinLogin}
                        onCheckedChange={handleAllowAdminPinLoginChange}
                        disabled={isSaving}
                      />
                    </div>
                    <p className="text-[11px] sm:text-xs text-muted-foreground">
                      Manage your own PIN under{" "}
                      <a
                        href="/admin-management/profile"
                        className="text-primary hover:underline"
                      >
                        Profile → Security
                      </a>
                      .
                    </p>
                  </div>
                  <Separator />
                  {/* IP allow-listing is a real architectural item (requires
                      edge-side enforcement + per-admin allow-list table). It is
                      surfaced honestly as a roadmap item rather than a fake
                      "Coming Soon" badge. */}
                  <div className="rounded-md border border-dashed p-3 space-y-1">
                    <div className="flex items-center justify-between gap-3">
                      <Label className="text-xs sm:text-sm">IP Allow-listing</Label>
                      <Badge variant="outline" className="text-[10px] sm:text-xs">Roadmap</Badge>
                    </div>
                    <p className="text-[11px] sm:text-xs text-muted-foreground">
                      Restrict admin access to approved IP ranges. Requires
                      edge-side enforcement; tracked as a separate hardening
                      item — not bundled with the cosmetic switches above.
                    </p>
                  </div>
                </CardContent>
              </Card>
            </div>
          </TabsContent>

          {/* Auth Email Templates Tab */}
          <TabsContent value="auth-templates" className="space-y-6">
            <AuthEmailTemplates />
          </TabsContent>

          {/* Content Tab */}
          <TabsContent value="content" className="space-y-6">
            <DemoVideoManagement />
          </TabsContent>

          {/* Monitoring Tab */}
          <TabsContent value="monitoring" className="space-y-6">
            <SentrySettings />
          </TabsContent>

          {/* System Tab */}
          <TabsContent value="system" className="space-y-4 sm:space-y-6">
            <div className="grid gap-4 sm:gap-6 lg:grid-cols-2">
              <Card className={maintenanceMode ? "border-amber-500/50 bg-amber-500/5" : ""}>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2 flex-wrap">
                    <Server className="h-4 w-4 sm:h-5 sm:w-5" />
                    Maintenance Mode
                    {maintenanceMode && (
                      <Badge variant="outline" className="text-[10px] sm:text-xs text-amber-600 border-amber-500">Active</Badge>
                    )}
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">Temporarily disable access for maintenance</CardDescription>
                </CardHeader>
                <CardContent className="space-y-3 sm:space-y-4 p-4 sm:p-6 pt-0 sm:pt-0">
                  <div className="flex items-center justify-between gap-3">
                    <div className="space-y-0.5 min-w-0">
                      <Label className="text-xs sm:text-sm">Enable Maintenance Mode</Label>
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Users will see a maintenance page</p>
                    </div>
                    <Switch checked={maintenanceMode} onCheckedChange={handleMaintenanceModeChange} disabled={isSaving} />
                  </div>
                  {maintenanceMode && (
                    <div className="p-2.5 sm:p-3 rounded-lg bg-amber-500/10 border border-amber-500/20">
                      <p className="text-xs sm:text-sm text-amber-700 dark:text-amber-400">
                        ⚠️ Maintenance mode is active. Users cannot access the platform.
                      </p>
                    </div>
                  )}
                </CardContent>
              </Card>

              <Card>
                <CardHeader className="p-4 sm:p-6">
                  <CardTitle className="text-sm sm:text-base flex items-center gap-2">
                    <Database className="h-4 w-4 sm:h-5 sm:w-5" />
                    System Information
                  </CardTitle>
                  <CardDescription className="text-xs sm:text-sm">Platform infrastructure details</CardDescription>
                </CardHeader>
                <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0">
                  <div className="grid gap-2.5 sm:gap-4 grid-cols-2">
                    <div className="p-2.5 sm:p-4 rounded-lg bg-muted/50">
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Database</p>
                      <p className="text-xs sm:text-sm font-medium">PostgreSQL 15</p>
                    </div>
                    <div className="p-2.5 sm:p-4 rounded-lg bg-muted/50">
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Auth Provider</p>
                      <p className="text-xs sm:text-sm font-medium">Supabase Auth</p>
                    </div>
                    <div className="p-2.5 sm:p-4 rounded-lg bg-muted/50">
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Storage</p>
                      <p className="text-xs sm:text-sm font-medium">Supabase Storage</p>
                    </div>
                    <div className="p-2.5 sm:p-4 rounded-lg bg-muted/50">
                      <p className="text-[11px] sm:text-sm text-muted-foreground">Region</p>
                      <p className="text-xs sm:text-sm font-medium">US East</p>
                    </div>
                  </div>
                </CardContent>
              </Card>
            </div>

            <DataResetTool />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
