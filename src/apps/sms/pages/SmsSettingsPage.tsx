import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { Badge } from "@/components/ui/badge";
import { useSmsConfig, type SmsMode } from "@/hooks/useSmsConfig";
import { Settings, Send, Loader2, Eye, EyeOff, ExternalLink, AlertTriangle, Info, FlaskConical, Radio } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { toast } from "sonner";
import { format } from "date-fns";
import { SmsWebhookHealthCard } from "@/apps/sms/components/SmsWebhookHealthCard";

const ACCOUNT_SID_RE = /^AC[a-zA-Z0-9]{32}$/;

export default function SmsSettingsPage() {
  const { config, isLoading, upsertConfig, testConnection } = useSmsConfig();
  const [providerMode, setProviderMode] = useState<SmsMode>("test");
  const [accountSid, setAccountSid] = useState("");
  const [authToken, setAuthToken] = useState("");
  const [senderPhone, setSenderPhone] = useState("");
  const [messagingServiceSid, setMessagingServiceSid] = useState("");
  const [isEnabled, setIsEnabled] = useState(false);
  const [testPhone, setTestPhone] = useState("");
  const [showToken, setShowToken] = useState(false);
  const [initialized, setInitialized] = useState(false);

  if (config && !initialized) {
    setProviderMode(config.provider_mode || "test");
    setSenderPhone(config.sender_phone || "");
    setMessagingServiceSid(config.messaging_service_sid || "");
    setIsEnabled(config.is_enabled);
    setInitialized(true);
  }

  const handleSave = () => {
    if (accountSid && !ACCOUNT_SID_RE.test(accountSid)) {
      toast.error("Account SID must look like ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx");
      return;
    }
    if (authToken && authToken.length < 32) {
      toast.error("Auth Token looks too short. Copy it from the Twilio Console.");
      return;
    }
    const payload: Parameters<typeof upsertConfig.mutate>[0] = {
      provider: "twilio",
      provider_mode: providerMode,
      is_enabled: isEnabled,
      // In test mode, sender fields are managed by Twilio's magic numbers — clear stored values.
      sender_phone: providerMode === "test" ? null : (senderPhone || null),
      messaging_service_sid: providerMode === "test" ? null : (messagingServiceSid || null),
    };
    if (accountSid) payload.account_sid = accountSid;
    if (authToken) payload.auth_token = authToken;
    upsertConfig.mutate(payload);
  };

  const handleTest = () => {
    if (testPhone) testConnection.mutate(testPhone);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const isExistingConfig = !!config?.id;
  const hasCredentials = isExistingConfig || (!!accountSid && !!authToken);
  const lastTestAt = config?.last_test_at ? format(new Date(config.last_test_at), "PPp") : null;
  const lastTestOk = config?.last_test_status === "success";

  return (
    <div className="space-y-6 max-w-2xl px-4 sm:px-0">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl sm:text-2xl font-bold tracking-tight">Twilio SMS Integration</h2>
          <p className="text-muted-foreground">
            Connect your own Twilio account. Switch between Test and Live mode just like Stripe.
          </p>
        </div>
        {isExistingConfig && (
          <Badge variant={providerMode === "live" ? "default" : "secondary"} className="gap-1">
            {providerMode === "live" ? <Radio className="h-3 w-3" /> : <FlaskConical className="h-3 w-3" />}
            {providerMode === "live" ? "Live mode" : "Test mode"}
          </Badge>
        )}
      </div>

      {isExistingConfig && <SmsWebhookHealthCard />}

      <Alert>
        <Info className="h-4 w-4" />
        <AlertTitle>Bring Your Own Account</AlertTitle>
        <AlertDescription className="space-y-1">
          <p>This integration uses <strong>your Twilio account</strong>. SMS costs are billed directly by Twilio.</p>
          <a
            href="https://www.twilio.com/console"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 text-sm font-medium text-primary hover:underline"
          >
            Open Twilio Console <ExternalLink className="h-3 w-3" />
          </a>
        </AlertDescription>
      </Alert>

      {/* Mode banner */}
      {providerMode === "test" ? (
        <Alert>
          <FlaskConical className="h-4 w-4" />
          <AlertTitle>Test Mode</AlertTitle>
          <AlertDescription className="space-y-1">
            <p>
              SMS is <strong>simulated by Twilio</strong>. No real messages are delivered and you are not billed.
              Use the <strong>Test Credentials</strong> from your Twilio Console (not your live keys).
            </p>
            <p className="text-xs text-muted-foreground">
              Twilio will accept the magic sender <code className="font-mono">+15005550006</code> automatically.
              Recipient <code className="font-mono">+15005550006</code> simulates success;{" "}
              <code className="font-mono">+15005550001</code> simulates an invalid number.
            </p>
          </AlertDescription>
        </Alert>
      ) : (
        <Alert variant="destructive">
          <AlertTriangle className="h-4 w-4" />
          <AlertTitle>Live Mode</AlertTitle>
          <AlertDescription>
            Real SMS will be sent and billed by Twilio. Verify your sender, enable{" "}
            <a href="https://www.twilio.com/docs/messaging/features/sms-pumping-protection-programmable-messaging" target="_blank" rel="noopener noreferrer" className="underline">SMS Pumping Protection</a>, and review{" "}
            <a href="https://www.twilio.com/docs/messaging/guides/preventing-messaging-fraud" target="_blank" rel="noopener noreferrer" className="underline">Geo-Permissions</a> in your Twilio account.
          </AlertDescription>
        </Alert>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Settings className="h-5 w-5" />
            Twilio Credentials
          </CardTitle>
          <CardDescription>
            Pick a mode, then paste the credentials for that mode from your{" "}
            <a href="https://www.twilio.com/console" target="_blank" rel="noopener noreferrer" className="underline">Twilio Console</a>.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {/* Mode toggle */}
          <div className="space-y-2">
            <Label>Mode</Label>
            <RadioGroup value={providerMode} onValueChange={(v) => setProviderMode(v as SmsMode)} className="grid grid-cols-2 gap-2">
              <label className={`flex items-start gap-2 rounded-md border p-3 cursor-pointer ${providerMode === "test" ? "border-primary bg-primary/5" : "border-border"}`}>
                <RadioGroupItem value="test" id="mode-test" className="mt-0.5" />
                <div className="space-y-0.5">
                  <div className="font-medium text-sm flex items-center gap-1"><FlaskConical className="h-3.5 w-3.5" /> Test</div>
                  <div className="text-xs text-muted-foreground">Simulated. No real SMS, no billing.</div>
                </div>
              </label>
              <label className={`flex items-start gap-2 rounded-md border p-3 cursor-pointer ${providerMode === "live" ? "border-primary bg-primary/5" : "border-border"}`}>
                <RadioGroupItem value="live" id="mode-live" className="mt-0.5" />
                <div className="space-y-0.5">
                  <div className="font-medium text-sm flex items-center gap-1"><Radio className="h-3.5 w-3.5" /> Live</div>
                  <div className="text-xs text-muted-foreground">Real SMS, billed by Twilio.</div>
                </div>
              </label>
            </RadioGroup>
          </div>

          <div className="flex items-center justify-between">
            <div>
              <Label htmlFor="sms-enabled">Enable SMS</Label>
              <p className="text-xs text-muted-foreground">
                When off, no SMS is sent — even from invoices or automations.
              </p>
            </div>
            <Switch
              id="sms-enabled"
              checked={isEnabled}
              onCheckedChange={setIsEnabled}
              disabled={!hasCredentials && !config?.id}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="account-sid">Account SID</Label>
            <Input
              id="account-sid"
              value={accountSid}
              onChange={(e) => setAccountSid(e.target.value.trim())}
              placeholder={config?.account_sid_masked || "ACxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}
            />
            {isExistingConfig && !accountSid && (
              <p className="text-xs text-muted-foreground">Leave empty to keep current value ({config?.account_sid_masked})</p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="auth-token">Auth Token</Label>
            <div className="relative">
              <Input
                id="auth-token"
                type={showToken ? "text" : "password"}
                value={authToken}
                onChange={(e) => setAuthToken(e.target.value)}
                placeholder={isExistingConfig ? "Leave empty to keep current value" : "Your Twilio Auth Token"}
              />
              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="absolute right-0 top-0 h-full px-3"
                onClick={() => setShowToken(!showToken)}
              >
                {showToken ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
              </Button>
            </div>
          </div>

          {/* Sender configuration — visible in both modes for clarity, but only writable in Live mode */}
          {providerMode === "live" ? (
            <>
              <div className="space-y-2">
                <Label htmlFor="sender-phone">Sender Phone Number</Label>
                <Input
                  id="sender-phone"
                  value={senderPhone}
                  onChange={(e) => setSenderPhone(e.target.value.trim())}
                  placeholder="+18777804236"
                />
                <p className="text-xs text-muted-foreground">
                  Must be an SMS-capable number on your Twilio account (E.164). Pre-purchase, you can use a{" "}
                  <a href="https://www.twilio.com/console/dev-phone" target="_blank" rel="noopener noreferrer" className="underline">
                    Twilio Virtual Phone Number
                  </a>{" "}
                  here — paste its E.164 number and view delivered messages in the Twilio Console. For US toll-free production sending, complete{" "}
                  <a href="https://www.twilio.com/docs/messaging/compliance/toll-free-message-verification" target="_blank" rel="noopener noreferrer" className="underline">
                    toll-free verification
                  </a> first.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="messaging-service">Messaging Service SID (optional, takes precedence)</Label>
                <Input
                  id="messaging-service"
                  value={messagingServiceSid}
                  onChange={(e) => setMessagingServiceSid(e.target.value.trim())}
                  placeholder="MGxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"
                />
              </div>
            </>
          ) : (
            <div className="space-y-2">
              <Label>Sender Phone Number</Label>
              <Input value="+15005550006" readOnly disabled className="font-mono" />
              <Alert>
                <Info className="h-4 w-4" />
                <AlertDescription className="text-xs space-y-1">
                  <p>
                    Twilio Test Credentials require the magic sender <code className="font-mono">+15005550006</code>.
                    Your own Twilio numbers (including Virtual Phone Numbers) cannot be used in this mode — that's a
                    Twilio constraint, not the app.
                  </p>
                  <p>
                    To send a real (or Virtual-Phone-routed) SMS from a number you own, switch to{" "}
                    <strong>Live mode</strong> above and paste your Twilio number as the Sender.
                  </p>
                </AlertDescription>
              </Alert>
            </div>
          )}

          {!isExistingConfig && !accountSid && !authToken && (
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription>
                Provide your Account SID and Auth Token to enable SMS.
              </AlertDescription>
            </Alert>
          )}

          <Button onClick={handleSave} disabled={upsertConfig.isPending || !hasCredentials}>
            {upsertConfig.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Configuration
          </Button>
        </CardContent>
      </Card>

      {config?.id && (
        <>
          {providerMode === "live" && (
            <Card>
              <CardHeader>
                <CardTitle className="flex items-center gap-2">
                  <ExternalLink className="h-5 w-5" />
                  Twilio Webhook URL
                </CardTitle>
                <CardDescription>
                  Paste this URL into <strong>both</strong> places in your Twilio Console
                  for the sender phone number / Messaging Service:
                  <ul className="list-disc pl-5 mt-2 space-y-0.5">
                    <li><strong>Status Callback URL</strong> — for delivery receipts.</li>
                    <li><strong>A MESSAGE COMES IN → Webhook</strong> — for inbound STOP/HELP/START handling (compliance-mandatory).</li>
                  </ul>
                </CardDescription>
              </CardHeader>
              <CardContent>
                <div className="flex flex-col sm:flex-row items-stretch sm:items-center gap-2">
                  <Input
                    readOnly
                    value={`${import.meta.env.VITE_SUPABASE_URL || "https://jkszmrroyjfdwokbkzis.supabase.co"}/functions/v1/sms-webhook`}
                    className="font-mono text-xs overflow-x-auto"
                  />
                  <Button
                    variant="outline"
                    size="sm"
                    className="shrink-0"
                    onClick={() => {
                      navigator.clipboard.writeText(
                        `${import.meta.env.VITE_SUPABASE_URL || "https://jkszmrroyjfdwokbkzis.supabase.co"}/functions/v1/sms-webhook`
                      );
                      toast.success("Webhook URL copied to clipboard");
                    }}
                  >
                    Copy
                  </Button>
                </div>
                <Alert className="mt-3">
                  <Info className="h-4 w-4" />
                  <AlertDescription className="text-xs">
                    Inbound STOP / STOPALL / UNSUBSCRIBE / CANCEL / END / QUIT auto-add the sender to your opt-out list.
                    HELP returns your configured help message. START / UNSTOP / YES re-subscribes.
                    Anything else is logged to your SMS Log under <em>Direction = inbound</em>.
                    Test mode does not exercise inbound webhooks (per Twilio).
                  </AlertDescription>
                </Alert>
              </CardContent>
            </Card>
          )}


          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Send className="h-5 w-5" />
                Test Connection
              </CardTitle>
              <CardDescription>
                {providerMode === "test"
                  ? "Send a simulated SMS through Twilio to verify your test credentials. Try +15005550006 (success) or +15005550001 (invalid)."
                  : "Send a real test SMS to a phone you control to verify your live credentials and sender."}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="test-phone">Recipient Phone Number (E.164)</Label>
                <Input
                  id="test-phone"
                  value={testPhone}
                  onChange={(e) => setTestPhone(e.target.value.trim())}
                  placeholder={providerMode === "test" ? "+15005550006" : "+14155552671"}
                />
              </div>
              <Button onClick={handleTest} disabled={testConnection.isPending || !testPhone} variant="secondary">
                {testConnection.isPending && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Send Test SMS
              </Button>

              {lastTestAt && (
                <div className="text-xs text-muted-foreground border-t pt-3">
                  Last test: <span className="font-medium">{lastTestAt}</span> —{" "}
                  <span className={lastTestOk ? "text-primary" : "text-destructive"}>
                    {config?.last_test_status || "unknown"}
                  </span>
                  {config?.last_test_error && (
                    <div className="mt-1 text-destructive">{config.last_test_error}</div>
                  )}
                </div>
              )}
            </CardContent>
          </Card>
        </>
      )}
    </div>
  );
}
