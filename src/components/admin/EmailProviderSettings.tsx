import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { 
  Mail, 
  Eye, 
  EyeOff, 
  Check, 
  X, 
  Loader2,
  ExternalLink,
  AlertCircle
} from "lucide-react";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";

export function EmailProviderSettings() {
  const { settings, isLoading, isSaving, getSetting, updateMultipleSettings } = usePlatformSettings();
  
  const [activeProvider, setActiveProvider] = useState("resend");
  const [showApiKey, setShowApiKey] = useState(false);
  
  // Form states
  const [resendApiKey, setResendApiKey] = useState("");
  const [resendFromEmail, setResendFromEmail] = useState("");
  const [resendFromName, setResendFromName] = useState("");
  // Scoped Reply-To fields — replaces single global resend_reply_to_email.
  // System notifications NEVER use these; they only apply to invitations / admin emails.
  const [supportReplyToEmail, setSupportReplyToEmail] = useState("");
  const [platformAdminReplyToEmail, setPlatformAdminReplyToEmail] = useState("");
  const [appBaseUrl, setAppBaseUrl] = useState("");
  
  const [sendgridApiKey, setSendgridApiKey] = useState("");
  
  const [mailgunApiKey, setMailgunApiKey] = useState("");
  const [mailgunDomain, setMailgunDomain] = useState("");

  // Load settings when available
  useEffect(() => {
    if (settings.length > 0) {
      setActiveProvider(getSetting("email_provider") || "resend");
      setResendApiKey(getSetting("resend_api_key") || "");
      setResendFromEmail(getSetting("resend_from_email") || "");
      setResendFromName(getSetting("resend_from_name") || "");
      setSupportReplyToEmail(getSetting("support_reply_to_email") || "");
      setPlatformAdminReplyToEmail(getSetting("platform_admin_reply_to_email") || "");
      setAppBaseUrl(getSetting("app_base_url") || "");
      setSendgridApiKey(getSetting("sendgrid_api_key") || "");
      setMailgunApiKey(getSetting("mailgun_api_key") || "");
      setMailgunDomain(getSetting("mailgun_domain") || "");
    }
  }, [settings]);

  const handleSaveResend = async () => {
    await updateMultipleSettings([
      { key: "email_provider", value: "resend" },
      { key: "resend_api_key", value: resendApiKey || null },
      { key: "resend_from_email", value: resendFromEmail || null },
      { key: "resend_from_name", value: resendFromName || null },
      // Scoped Reply-To fields. System notifications never use these.
      { key: "support_reply_to_email", value: supportReplyToEmail || null },
      { key: "platform_admin_reply_to_email", value: platformAdminReplyToEmail || null },
      { key: "app_base_url", value: appBaseUrl || null },
    ]);
  };

  const handleSaveSendGrid = async () => {
    await updateMultipleSettings([
      { key: "email_provider", value: "sendgrid" },
      { key: "sendgrid_api_key", value: sendgridApiKey || null },
    ]);
  };

  const handleSaveMailgun = async () => {
    await updateMultipleSettings([
      { key: "email_provider", value: "mailgun" },
      { key: "mailgun_api_key", value: mailgunApiKey || null },
      { key: "mailgun_domain", value: mailgunDomain || null },
    ]);
  };

  const currentProvider = getSetting("email_provider") || "resend";
  const isConfigured = (provider: string) => {
    switch (provider) {
      case "resend":
        return !!getSetting("resend_api_key");
      case "sendgrid":
        return !!getSetting("sendgrid_api_key");
      case "mailgun":
        return !!getSetting("mailgun_api_key") && !!getSetting("mailgun_domain");
      default:
        return false;
    }
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="p-4 sm:p-6">
        <CardTitle className="text-sm sm:text-base flex items-center gap-2 flex-wrap">
          <Mail className="h-4 w-4 sm:h-5 sm:w-5" />
          Email Service Provider
          {isConfigured(currentProvider) ? (
            <Badge variant="default" className="bg-green-600 text-[10px] sm:text-xs">
              <Check className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-0.5 sm:mr-1" />
              Configured
            </Badge>
          ) : (
            <Badge variant="secondary" className="text-[10px] sm:text-xs">
              <X className="h-2.5 w-2.5 sm:h-3 sm:w-3 mr-0.5 sm:mr-1" />
              Not Configured
            </Badge>
          )}
        </CardTitle>
        <CardDescription className="text-xs sm:text-sm">
          Configure email service for sending invoices, reminders, and notifications
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4 sm:space-y-6 p-4 sm:p-6 pt-0 sm:pt-0">
        <Alert>
          <AlertCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
          <AlertDescription className="text-[11px] sm:text-sm">
            Email provider credentials are stored securely and used by the system to send emails on behalf of all organizations.
          </AlertDescription>
        </Alert>

        <Tabs value={activeProvider} onValueChange={setActiveProvider}>
          <TabsList className="grid w-full grid-cols-3 h-auto">
            <TabsTrigger value="resend" className="flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1.5 sm:px-3 sm:py-2">
              Resend
              {currentProvider === "resend" && isConfigured("resend") && (
                <Check className="h-2.5 w-2.5 sm:h-3 sm:w-3 text-green-600" />
              )}
            </TabsTrigger>
            <TabsTrigger value="sendgrid" className="flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1.5 sm:px-3 sm:py-2">
              SendGrid
              {currentProvider === "sendgrid" && isConfigured("sendgrid") && (
                <Check className="h-2.5 w-2.5 sm:h-3 sm:w-3 text-green-600" />
              )}
            </TabsTrigger>
            <TabsTrigger value="mailgun" className="flex items-center gap-1 sm:gap-2 text-[10px] sm:text-xs lg:text-sm px-1.5 py-1.5 sm:px-3 sm:py-2">
              Mailgun
              {currentProvider === "mailgun" && isConfigured("mailgun") && (
                <Check className="h-2.5 w-2.5 sm:h-3 sm:w-3 text-green-600" />
              )}
            </TabsTrigger>
          </TabsList>

          {/* Resend */}
          <TabsContent value="resend" className="space-y-3 sm:space-y-4 mt-3 sm:mt-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 sm:gap-2">
              <p className="text-[11px] sm:text-sm text-muted-foreground">
                Resend is the recommended email provider for its simplicity and reliability.
              </p>
              <a
                href="https://resend.com/api-keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] sm:text-sm text-primary hover:underline flex items-center gap-1 shrink-0"
              >
                Get API Key <ExternalLink className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
              </a>
            </div>

            <div className="space-y-3 sm:space-y-4">
              <div className="space-y-1.5 sm:space-y-2">
                <Label htmlFor="resend-api-key" className="text-xs sm:text-sm">API Key</Label>
                <div className="relative">
                  <Input
                    id="resend-api-key"
                    type={showApiKey ? "text" : "password"}
                    value={resendApiKey}
                    onChange={(e) => setResendApiKey(e.target.value)}
                    placeholder="re_xxxxxxxxxx"
                    className="pr-10 text-xs sm:text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-2.5 sm:px-3"
                    onClick={() => setShowApiKey(!showApiKey)}
                  >
                    {showApiKey ? (
                      <EyeOff className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="grid gap-3 sm:gap-4 grid-cols-1 sm:grid-cols-2">
                <div className="space-y-1.5 sm:space-y-2">
                  <Label htmlFor="resend-from-email" className="text-xs sm:text-sm">From Email</Label>
                  <Input
                    id="resend-from-email"
                    type="email"
                    value={resendFromEmail}
                    onChange={(e) => setResendFromEmail(e.target.value)}
                    placeholder="noreply@accrualflow.systems"
                    className="text-xs sm:text-sm"
                  />
                  <p className="text-[10px] sm:text-xs text-muted-foreground">
                    Must be verified in Resend dashboard
                  </p>
                </div>

                <div className="space-y-1.5 sm:space-y-2">
                  <Label htmlFor="resend-from-name" className="text-xs sm:text-sm">From Name</Label>
                  <Input
                    id="resend-from-name"
                    value={resendFromName}
                    onChange={(e) => setResendFromName(e.target.value)}
                    placeholder="AccrualFlow"
                    className="text-xs sm:text-sm"
                  />
                </div>
              </div>

              <Alert>
                <AlertCircle className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                <AlertDescription className="text-[11px] sm:text-sm">
                  System notifications (low stock, payment received, etc.) never use a Reply-To address — they're system-generated. The fields below apply only to invitations and admin-composed emails.
                </AlertDescription>
              </Alert>

              <div className="space-y-1.5 sm:space-y-2">
                <Label htmlFor="support-reply-to" className="text-xs sm:text-sm">Support Reply-To</Label>
                <Input
                  id="support-reply-to"
                  type="email"
                  value={supportReplyToEmail}
                  onChange={(e) => setSupportReplyToEmail(e.target.value)}
                  placeholder="support@accrualflow.systems"
                  className="text-xs sm:text-sm"
                />
                <p className="text-[10px] sm:text-xs text-muted-foreground">
                  Used for invitation and user-facing support emails. Leave blank to send without Reply-To.
                </p>
              </div>

              <div className="space-y-1.5 sm:space-y-2">
                <Label htmlFor="platform-admin-reply-to" className="text-xs sm:text-sm">Platform Admin Reply-To</Label>
                <Input
                  id="platform-admin-reply-to"
                  type="email"
                  value={platformAdminReplyToEmail}
                  onChange={(e) => setPlatformAdminReplyToEmail(e.target.value)}
                  placeholder="admin@accrualflow.systems"
                  className="text-xs sm:text-sm"
                />
                <p className="text-[10px] sm:text-xs text-muted-foreground">
                  Used only for platform admin / manually composed emails. NOT used on system notifications.
                </p>
              </div>

              <div className="space-y-1.5 sm:space-y-2">
                <Label htmlFor="app-base-url" className="text-xs sm:text-sm">App Base URL</Label>
                <Input
                  id="app-base-url"
                  type="url"
                  value={appBaseUrl}
                  onChange={(e) => setAppBaseUrl(e.target.value)}
                  placeholder="https://app.accrualflow.systems"
                  className="text-xs sm:text-sm"
                />
                <p className="text-[10px] sm:text-xs text-muted-foreground">
                  Absolute URL of your app. Used to build clickable deep-links (View invoice, View product, etc.) in notification emails.
                </p>
              </div>
            </div>

            <Button onClick={handleSaveResend} disabled={isSaving} size="sm" className="w-full sm:w-auto text-xs sm:text-sm">
              {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Save & Activate Resend
            </Button>
          </TabsContent>

          {/* SendGrid */}
          <TabsContent value="sendgrid" className="space-y-3 sm:space-y-4 mt-3 sm:mt-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 sm:gap-2">
              <p className="text-[11px] sm:text-sm text-muted-foreground">
                SendGrid is a popular email service by Twilio with robust delivery.
              </p>
              <a
                href="https://app.sendgrid.com/settings/api_keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] sm:text-sm text-primary hover:underline flex items-center gap-1 shrink-0"
              >
                Get API Key <ExternalLink className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
              </a>
            </div>

            <div className="space-y-1.5 sm:space-y-2">
              <Label htmlFor="sendgrid-api-key" className="text-xs sm:text-sm">API Key</Label>
              <div className="relative">
                <Input
                  id="sendgrid-api-key"
                  type={showApiKey ? "text" : "password"}
                  value={sendgridApiKey}
                  onChange={(e) => setSendgridApiKey(e.target.value)}
                  placeholder="SG.xxxxxxxxxx"
                  className="pr-10 text-xs sm:text-sm"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className="absolute right-0 top-0 h-full px-2.5 sm:px-3"
                  onClick={() => setShowApiKey(!showApiKey)}
                >
                  {showApiKey ? (
                    <EyeOff className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  ) : (
                    <Eye className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                  )}
                </Button>
              </div>
            </div>

            <Button onClick={handleSaveSendGrid} disabled={isSaving} size="sm" className="w-full sm:w-auto text-xs sm:text-sm">
              {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Save & Activate SendGrid
            </Button>
          </TabsContent>

          {/* Mailgun */}
          <TabsContent value="mailgun" className="space-y-3 sm:space-y-4 mt-3 sm:mt-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1.5 sm:gap-2">
              <p className="text-[11px] sm:text-sm text-muted-foreground">
                Mailgun offers powerful email APIs with detailed analytics.
              </p>
              <a
                href="https://app.mailgun.com/app/account/security/api_keys"
                target="_blank"
                rel="noopener noreferrer"
                className="text-[11px] sm:text-sm text-primary hover:underline flex items-center gap-1 shrink-0"
              >
                Get API Key <ExternalLink className="h-2.5 w-2.5 sm:h-3 sm:w-3" />
              </a>
            </div>

            <div className="space-y-3 sm:space-y-4">
              <div className="space-y-1.5 sm:space-y-2">
                <Label htmlFor="mailgun-api-key" className="text-xs sm:text-sm">API Key</Label>
                <div className="relative">
                  <Input
                    id="mailgun-api-key"
                    type={showApiKey ? "text" : "password"}
                    value={mailgunApiKey}
                    onChange={(e) => setMailgunApiKey(e.target.value)}
                    placeholder="key-xxxxxxxxxx"
                    className="pr-10 text-xs sm:text-sm"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    className="absolute right-0 top-0 h-full px-2.5 sm:px-3"
                    onClick={() => setShowApiKey(!showApiKey)}
                  >
                    {showApiKey ? (
                      <EyeOff className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                    ) : (
                      <Eye className="h-3.5 w-3.5 sm:h-4 sm:w-4" />
                    )}
                  </Button>
                </div>
              </div>

              <div className="space-y-1.5 sm:space-y-2">
                <Label htmlFor="mailgun-domain" className="text-xs sm:text-sm">Domain</Label>
                <Input
                  id="mailgun-domain"
                  value={mailgunDomain}
                  onChange={(e) => setMailgunDomain(e.target.value)}
                  placeholder="mg.yourdomain.com"
                  className="text-xs sm:text-sm"
                />
              </div>
            </div>

            <Button onClick={handleSaveMailgun} disabled={isSaving} size="sm" className="w-full sm:w-auto text-xs sm:text-sm">
              {isSaving && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
              Save & Activate Mailgun
            </Button>
          </TabsContent>
        </Tabs>

        {/* Current Status */}
        <div className="pt-3 sm:pt-4 border-t">
          <div className="flex items-center justify-between text-[11px] sm:text-sm">
            <span className="text-muted-foreground">Active Provider:</span>
            <Badge variant={isConfigured(currentProvider) ? "default" : "secondary"} className="text-[10px] sm:text-xs">
              {currentProvider.charAt(0).toUpperCase() + currentProvider.slice(1)}
            </Badge>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
