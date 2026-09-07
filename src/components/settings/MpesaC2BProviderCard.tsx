import { useState, useEffect } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Badge } from "@/components/ui/badge";
import { 
  Loader2, 
  Building2, 
  Eye, 
  EyeOff, 
  Trash2, 
  ExternalLink, 
  AlertTriangle, 
  CheckCircle, 
  XCircle, 
  Copy,
  ArrowDownToLine 
} from "lucide-react";
import { usePaymentProviders } from "@/hooks/usePaymentProviders";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useQueryClient } from "@tanstack/react-query";
import { normalizeError } from "@/services/resilience";

interface MpesaC2BConfig {
  consumer_key: string;
  consumer_secret: string;
  business_short_code: string;
  shortcode_type: "paybill" | "till";
  response_type?: string;
  validation_url?: string;
  confirmation_url?: string;
  registered_at?: string;
}

export function MpesaC2BProviderCard() {
  const { 
    getProviderConfig, 
    saveProviderConfig, 
    toggleProviderActive, 
    deleteProviderConfig,
    isLoading, 
    isSaving 
  } = usePaymentProviders();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const c2bConfig = getProviderConfig("mpesa_c2b");

  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [businessShortCode, setBusinessShortCode] = useState("");
  const [shortcodeType, setShortcodeType] = useState<"paybill" | "till">("paybill");
  const [showSecrets, setShowSecrets] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isRegistering, setIsRegistering] = useState(false);

  useEffect(() => {
    if (c2bConfig && !isEditing) {
      const config = c2bConfig.config as MpesaC2BConfig;
      setConsumerKey(config.consumer_key || "");
      setBusinessShortCode(config.business_short_code || "");
      setShortcodeType(config.shortcode_type || "paybill");
    }
  }, [c2bConfig, isEditing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!consumerKey || !consumerSecret || !businessShortCode) {
      toast({
        title: "Missing fields",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    try {
      const config: MpesaC2BConfig = {
        consumer_key: consumerKey,
        consumer_secret: consumerSecret,
        business_short_code: businessShortCode,
        shortcode_type: shortcodeType,
        response_type: "Completed",
      };

      await saveProviderConfig("mpesa_c2b", config, {
        displayName: "M-Pesa Paybill/Till (C2B)",
        isTestMode: false, // Environment controlled by platform admin
        isActive: false,
      });

      setConsumerSecret("");
      setIsEditing(false);
    } catch (error) {
      // Error handled in hook
    }
  };

  const handleRegisterUrls = async () => {
    if (!currentOrg?.id) return;
    if (!currentBusiness?.id) {
      toast({
        title: "Select a Company",
        description: "M-Pesa C2B credentials belong to a legal entity. Pick a Company first.",
        variant: "destructive",
      });
      return;
    }

    setIsRegistering(true);
    try {
      const { data: { session } } = await supabase.auth.getSession();

      const response = await fetch(
        `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/mpesa-c2b/register`,
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${session?.access_token}`,
          },
          body: JSON.stringify({
            organizationId: currentOrg.id,
            businessId: currentBusiness.id,
          }),
        }
      );

      const result = await response.json();

      if (!response.ok) {
        throw new Error(result.error || "Registration failed");
      }

      toast({
        title: "URLs Registered",
        description: "Callback URLs registered with Safaricom successfully",
      });

      // Refresh provider config without full page reload
      queryClient.invalidateQueries({ queryKey: ["payment-providers"] });
    } catch (error) {
      toast({
        title: "Registration Failed",
        description: error instanceof Error ? normalizeError(error).message : "Failed to register URLs",
        variant: "destructive",
      });
    } finally {
      setIsRegistering(false);
    }
  };

  const handleCopyCallback = () => {
    if (c2bConfig?.callback_url) {
      navigator.clipboard.writeText(c2bConfig.callback_url);
      toast({
        title: "Copied",
        description: "Confirmation URL copied to clipboard",
      });
    }
  };

  const maskValue = (value: string) => {
    if (!value || value.length <= 8) return "••••••••";
    return value.substring(0, 4) + "•".repeat(12) + value.substring(value.length - 4);
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
      <CardHeader>
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="h-10 w-10 rounded-lg bg-[#00a651] flex items-center justify-center flex-shrink-0">
              <ArrowDownToLine className="h-5 w-5 text-white" />
            </div>
            <div>
              <CardTitle className="flex items-center gap-2 text-base sm:text-lg">
                M-Pesa Paybill/Till (C2B)
                <Badge variant="outline" className="text-xs">Incoming</Badge>
              </CardTitle>
              <CardDescription>
                Receive payments when customers pay to your Paybill or Till
              </CardDescription>
            </div>
          </div>
          {c2bConfig && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={c2bConfig.is_test_mode ? "secondary" : "default"}>
                {c2bConfig.is_test_mode ? "Sandbox" : "Production"}
              </Badge>
              <Badge variant={c2bConfig.is_active ? "default" : "outline"}>
                {c2bConfig.is_active ? "Active" : "Inactive"}
              </Badge>
              {c2bConfig.test_result && (
                <Badge variant={c2bConfig.test_result === "success" ? "default" : "destructive"}>
                  {c2bConfig.test_result === "success" ? (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  ) : (
                    <XCircle className="h-3 w-3 mr-1" />
                  )}
                  {c2bConfig.test_result === "success" ? "Registered" : "Failed"}
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!c2bConfig && !isEditing ? (
          <div className="text-center py-6 space-y-4">
            <div className="bg-muted/50 rounded-lg p-6">
              <h3 className="font-medium mb-2">Receive M-Pesa Payments</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Configure your Paybill or Till number to automatically receive and record
                client repayments. Transactions are matched to loan repayments automatically.
              </p>
              <Button onClick={() => setIsEditing(true)}>
                <Building2 className="mr-2 h-4 w-4" />
                Configure C2B
              </Button>
            </div>
            <a
              href="https://developer.safaricom.co.ke/APIs/CustomerToBusinessRegisterURL"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline inline-flex items-center gap-1"
            >
              Learn about C2B API
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ) : isEditing ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="bg-blue-50 dark:bg-blue-950/30 border border-blue-200 dark:border-blue-900 rounded-lg p-3 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-blue-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-blue-800 dark:text-blue-200">
                <p className="font-medium">Important: Use the same credentials as STK Push</p>
                <p className="text-blue-700 dark:text-blue-300">
                  C2B uses the same Daraja app credentials. Your shortcode must be registered for C2B with Safaricom.
                </p>
              </div>
            </div>

            <div className="bg-muted/50 rounded-lg p-3">
              <p className="text-sm text-muted-foreground">
                <strong>Note:</strong> The M-Pesa environment (sandbox/production) is controlled by the platform administrator.
                Enter your credentials according to the current platform environment.
              </p>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="consumerKey">Consumer Key *</Label>
                <Input
                  id="consumerKey"
                  value={consumerKey}
                  onChange={(e) => setConsumerKey(e.target.value)}
                  placeholder="Your consumer key"
                  required
                />
              </div>

              <div className="space-y-2">
                <Label htmlFor="consumerSecret">Consumer Secret *</Label>
                <div className="relative">
                  <Input
                    id="consumerSecret"
                    type={showSecrets ? "text" : "password"}
                    value={consumerSecret}
                    onChange={(e) => setConsumerSecret(e.target.value)}
                    placeholder="Your consumer secret"
                    required
                    className="pr-10"
                  />
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    className="absolute right-0 top-0 h-full px-3"
                    onClick={() => setShowSecrets(!showSecrets)}
                  >
                    {showSecrets ? (
                      <EyeOff className="h-4 w-4 text-muted-foreground" />
                    ) : (
                      <Eye className="h-4 w-4 text-muted-foreground" />
                    )}
                  </Button>
                </div>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="businessShortCode">Business Short Code *</Label>
                <Input
                  id="businessShortCode"
                  value={businessShortCode}
                  onChange={(e) => setBusinessShortCode(e.target.value)}
                  placeholder="Your paybill/till number"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Your Paybill or Till number
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="shortcodeType">Shortcode Type</Label>
                <Select value={shortcodeType} onValueChange={(v) => setShortcodeType(v as "paybill" | "till")}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="paybill">Paybill Number</SelectItem>
                    <SelectItem value="till">Till Number (Buy Goods)</SelectItem>
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  {shortcodeType === "paybill" ? "Customers enter account number" : "No account number required"}
                </p>
              </div>
            </div>

            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Configuration
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsEditing(false);
                  setConsumerSecret("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-sm font-medium">Consumer Key</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {maskValue((c2bConfig?.config as MpesaC2BConfig)?.consumer_key || "")}
                </p>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-sm font-medium">Business Short Code</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {(c2bConfig?.config as MpesaC2BConfig)?.business_short_code || "Not set"}
                </p>
              </div>
            </div>

            <div className="p-3 bg-muted/50 rounded-lg">
              <p className="text-sm font-medium">Shortcode Type</p>
              <Badge variant="outline" className="mt-1">
                {(c2bConfig?.config as MpesaC2BConfig)?.shortcode_type === "till" ? "Till (Buy Goods)" : "Paybill"}
              </Badge>
            </div>

            {c2bConfig?.callback_url && (
              <div className="p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Confirmation URL</p>
                    <p className="text-sm text-muted-foreground font-mono break-all">
                      {c2bConfig.callback_url}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={handleCopyCallback}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                {(c2bConfig?.config as MpesaC2BConfig)?.registered_at && (
                  <p className="text-xs text-muted-foreground mt-1">
                    Registered: {new Date((c2bConfig?.config as MpesaC2BConfig)?.registered_at!).toLocaleString()}
                  </p>
                )}
              </div>
            )}

            {c2bConfig?.test_error && (
              <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                <p className="font-medium">Last error:</p>
                <p>{c2bConfig.test_error}</p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t">
              <div className="flex items-center gap-2">
                <Switch
                  checked={c2bConfig?.is_active || false}
                  onCheckedChange={(checked) => toggleProviderActive("mpesa_c2b", checked)}
                />
                <Label>Enable C2B receiving</Label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button 
                  variant="outline"
                  size="sm"
                  onClick={handleRegisterUrls}
                  disabled={isRegistering}
                >
                  {isRegistering && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Register URLs
                </Button>
                <Button variant="outline" size="sm" onClick={() => setIsEditing(true)}>
                  Update Credentials
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger asChild>
                    <Button variant="outline" size="icon" className="text-destructive h-9 w-9">
                      <Trash2 className="h-4 w-4" />
                    </Button>
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Remove C2B Configuration?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will delete your M-Pesa C2B configuration. You will no longer
                        receive automatic payment notifications.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => deleteProviderConfig("mpesa_c2b")}
                        className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                      >
                        Remove
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
