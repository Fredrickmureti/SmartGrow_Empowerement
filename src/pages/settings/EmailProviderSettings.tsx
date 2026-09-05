/**
 * Platform → Email delivery settings.
 *
 * Lets a platform admin configure the outbound email provider (Resend) at
 * runtime. Values are stored in `platform_settings` and read by the
 * `send-email` edge function, so no key is ever hardcoded or redeployed.
 * Reads/writes go through the security-definer RPCs
 * `get_email_provider_settings` / `set_email_provider_settings`, which
 * restrict access to platform admins and never return the key in clear text.
 */
import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Mail, ShieldAlert, KeyRound, Trash2 } from "lucide-react";

type EmailProviderSettings = {
  resend_from_email: string | null;
  resend_from_name: string | null;
  support_reply_to_email: string | null;
  platform_admin_reply_to_email: string | null;
  has_api_key: boolean;
  api_key_hint: string | null;
};

export default function EmailProviderSettings() {
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const { data, isLoading, error } = useQuery({
    queryKey: ["email-provider-settings"],
    queryFn: async () => {
      const { data, error } = await supabase.rpc("get_email_provider_settings" as any);
      if (error) throw error;
      return data as unknown as EmailProviderSettings;
    },
    retry: false,
  });

  const [apiKey, setApiKey] = useState("");
  const [fromEmail, setFromEmail] = useState("");
  const [fromName, setFromName] = useState("");
  const [supportReplyTo, setSupportReplyTo] = useState("");
  const [adminReplyTo, setAdminReplyTo] = useState("");

  useEffect(() => {
    if (!data) return;
    setFromEmail(data.resend_from_email ?? "");
    setFromName(data.resend_from_name ?? "");
    setSupportReplyTo(data.support_reply_to_email ?? "");
    setAdminReplyTo(data.platform_admin_reply_to_email ?? "");
  }, [data]);

  const save = useMutation({
    mutationFn: async (opts: { clearApiKey?: boolean }) => {
      const { data: result, error } = await supabase.rpc("set_email_provider_settings" as any, {
        _resend_api_key: opts.clearApiKey ? null : apiKey || null,
        _resend_from_email: fromEmail,
        _resend_from_name: fromName,
        _support_reply_to_email: supportReplyTo,
        _platform_admin_reply_to_email: adminReplyTo,
        _clear_api_key: !!opts.clearApiKey,
      });
      if (error) throw error;
      return result as unknown as EmailProviderSettings;
    },
    onSuccess: () => {
      setApiKey("");
      queryClient.invalidateQueries({ queryKey: ["email-provider-settings"] });
      toast({ title: "Email settings saved", description: "Outgoing email now uses these settings." });
    },
    onError: (e: any) => {
      toast({
        title: "Could not save",
        description: String(e?.message || "").includes("not_authorized")
          ? "Only platform administrators can change email settings."
          : e?.message || "Please try again.",
        variant: "destructive",
      });
    },
  });

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-16">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="max-w-2xl mx-auto p-6">
        <Alert variant="destructive">
          <ShieldAlert className="h-4 w-4" />
          <AlertTitle>No access</AlertTitle>
          <AlertDescription>
            Only platform administrators can view or change email delivery settings.
          </AlertDescription>
        </Alert>
      </div>
    );
  }

  return (
    <div className="max-w-2xl mx-auto p-6 space-y-6">
      <div className="flex items-center gap-3">
        <Mail className="h-5 w-5 text-muted-foreground" />
        <div>
          <h1 className="text-xl font-semibold">Email delivery</h1>
          <p className="text-sm text-muted-foreground">
            Configure the email provider used for invitations, notifications and receipts.
          </p>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <KeyRound className="h-4 w-4" /> Provider key
          </CardTitle>
          <CardDescription>
            Paste your Resend API key here when you have one. It is stored securely and never shown again.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex items-center gap-2">
            <span className="text-sm text-muted-foreground">Status:</span>
            {data?.has_api_key ? (
              <Badge variant="secondary">Configured {data.api_key_hint ? `(${data.api_key_hint})` : ""}</Badge>
            ) : (
              <Badge variant="destructive">Not configured — emails will not send</Badge>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="apiKey">API key</Label>
            <Input
              id="apiKey"
              type="password"
              autoComplete="off"
              placeholder={data?.has_api_key ? "Enter a new key to replace the current one" : "re_..."}
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
            />
          </div>

          {data?.has_api_key && (
            <Button
              variant="ghost"
              size="sm"
              className="text-destructive"
              disabled={save.isPending}
              onClick={() => save.mutate({ clearApiKey: true })}
            >
              <Trash2 className="h-4 w-4 mr-1" /> Remove saved key
            </Button>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Sender details</CardTitle>
          <CardDescription>How outgoing messages appear to recipients.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="space-y-2">
            <Label htmlFor="fromEmail">From address</Label>
            <Input
              id="fromEmail"
              type="email"
              placeholder="noreply@yourdomain.com"
              value={fromEmail}
              onChange={(e) => setFromEmail(e.target.value)}
            />
            <p className="text-xs text-muted-foreground">
              Must be on a domain you have verified with your email provider.
            </p>
          </div>
          <div className="space-y-2">
            <Label htmlFor="fromName">From name</Label>
            <Input
              id="fromName"
              placeholder="Smart Grow Empowerment"
              value={fromName}
              onChange={(e) => setFromName(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="supportReplyTo">Support reply-to</Label>
            <Input
              id="supportReplyTo"
              type="email"
              placeholder="support@yourdomain.com"
              value={supportReplyTo}
              onChange={(e) => setSupportReplyTo(e.target.value)}
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="adminReplyTo">Admin reply-to</Label>
            <Input
              id="adminReplyTo"
              type="email"
              placeholder="admin@yourdomain.com"
              value={adminReplyTo}
              onChange={(e) => setAdminReplyTo(e.target.value)}
            />
          </div>
        </CardContent>
      </Card>

      <div className="flex justify-end">
        <Button disabled={save.isPending} onClick={() => save.mutate({})}>
          {save.isPending && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
          Save settings
        </Button>
      </div>
    </div>
  );
}
