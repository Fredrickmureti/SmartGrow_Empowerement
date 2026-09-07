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
import { Loader2, Smartphone, Eye, EyeOff, Trash2, ExternalLink, AlertTriangle, CheckCircle, XCircle, Copy } from "lucide-react";
import { usePaymentProviders, MpesaConfig } from "@/hooks/usePaymentProviders";
import { useToast } from "@/hooks/use-toast";

export function MpesaProviderCard() {
  const { 
    getProviderConfig, 
    saveProviderConfig, 
    toggleProviderActive, 
    testProviderConnection,
    deleteProviderConfig,
    isLoading, 
    isSaving 
  } = usePaymentProviders();
  const { toast } = useToast();

  const mpesaConfig = getProviderConfig("mpesa");

  const [consumerKey, setConsumerKey] = useState("");
  const [consumerSecret, setConsumerSecret] = useState("");
  const [businessShortCode, setBusinessShortCode] = useState("");
  const [passkey, setPasskey] = useState("");
  const [accountReference, setAccountReference] = useState("");
  const [transactionType, setTransactionType] = useState<"CustomerPayBillOnline">("CustomerPayBillOnline");
  const [showSecrets, setShowSecrets] = useState(false);
  const [isEditing, setIsEditing] = useState(false);
  const [isTesting, setIsTesting] = useState(false);

  useEffect(() => {
    if (mpesaConfig && !isEditing) {
      const config = mpesaConfig.config as MpesaConfig;
      setConsumerKey(config.consumer_key || "");
      setBusinessShortCode(config.business_short_code || "");
      setAccountReference(config.account_reference || "");
      setTransactionType(config.transaction_type || "CustomerPayBillOnline");
      // Don't populate secrets for security
    }
  }, [mpesaConfig, isEditing]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    if (!consumerKey || !consumerSecret || !businessShortCode || !passkey) {
      toast({
        title: "Missing fields",
        description: "Please fill in all required fields",
        variant: "destructive",
      });
      return;
    }

    try {
      const config: MpesaConfig = {
        consumer_key: consumerKey,
        consumer_secret: consumerSecret,
        business_short_code: businessShortCode,
        passkey: passkey,
        account_reference: accountReference || "Payment",
        transaction_type: transactionType,
      };

      await saveProviderConfig("mpesa", config, {
        displayName: "M-Pesa",
        isTestMode: false, // Environment is controlled by platform admin
        isActive: false, // Start disabled until tested
      });

      setConsumerSecret("");
      setPasskey("");
      setIsEditing(false);
    } catch (error) {
      // Error already handled in hook
    }
  };

  const handleTest = async () => {
    setIsTesting(true);
    try {
      await testProviderConnection("mpesa");
    } finally {
      setIsTesting(false);
    }
  };

  const handleCopyCallback = () => {
    if (mpesaConfig?.callback_url) {
      navigator.clipboard.writeText(mpesaConfig.callback_url);
      toast({
        title: "Copied",
        description: "Callback URL copied to clipboard",
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
            <div className="h-10 w-10 rounded-lg bg-[#4caf50] flex items-center justify-center flex-shrink-0">
              <Smartphone className="h-5 w-5 text-white" />
            </div>
            <div>
              <CardTitle className="text-base sm:text-lg">M-Pesa (Safaricom)</CardTitle>
              <CardDescription>
                Accept mobile money payments via STK Push
              </CardDescription>
            </div>
          </div>
          {mpesaConfig && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={mpesaConfig.is_active ? "default" : "outline"}>
                {mpesaConfig.is_active ? "Active" : "Inactive"}
              </Badge>
              {mpesaConfig.test_result && (
                <Badge variant={mpesaConfig.test_result === "success" ? "default" : "destructive"}>
                  {mpesaConfig.test_result === "success" ? (
                    <CheckCircle className="h-3 w-3 mr-1" />
                  ) : (
                    <XCircle className="h-3 w-3 mr-1" />
                  )}
                  {mpesaConfig.test_result === "success" ? "Verified" : "Failed"}
                </Badge>
              )}
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!mpesaConfig && !isEditing ? (
          <div className="text-center py-6 space-y-4">
            <div className="bg-muted/50 rounded-lg p-6">
              <h3 className="font-medium mb-2">Connect M-Pesa Daraja API</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Enter your Safaricom Daraja API credentials to enable M-Pesa STK push payments.
                Customers will receive a prompt on their phone to enter their M-Pesa PIN.
              </p>
              <Button onClick={() => setIsEditing(true)}>
                <Smartphone className="mr-2 h-4 w-4" />
                Configure M-Pesa
              </Button>
            </div>
            <a
              href="https://developer.safaricom.co.ke"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline inline-flex items-center gap-1"
            >
              Get credentials from Safaricom Developer Portal
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ) : isEditing ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg p-3 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-800 dark:text-amber-200">
                <p className="font-medium">Secure your credentials</p>
                <p className="text-amber-700 dark:text-amber-300">
                  Your API credentials are encrypted before storage. Never share them publicly.
                </p>
              </div>
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
                  placeholder="Your PayBill number"
                  required
                />
                <p className="text-xs text-muted-foreground">
                  Your PayBill number from Safaricom
                </p>
              </div>

              <div className="space-y-2">
                <Label htmlFor="passkey">Passkey (Lipa Na M-Pesa Online) *</Label>
                <div className="relative">
                  <Input
                    id="passkey"
                    type={showSecrets ? "text" : "password"}
                    value={passkey}
                    onChange={(e) => setPasskey(e.target.value)}
                    placeholder="Your passkey"
                    required
                    className="pr-10"
                  />
                </div>
                <p className="text-xs text-muted-foreground">
                  Provided by Safaricom Daraja
                </p>
              </div>
            </div>

            <div className="grid gap-4 sm:grid-cols-2">
              <div className="space-y-2">
                <Label htmlFor="transactionType">Transaction Type</Label>
                <Select value={transactionType} onValueChange={(v) => setTransactionType(v as typeof transactionType)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="CustomerPayBillOnline">Paybill (CustomerPayBillOnline)</SelectItem>
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <Label htmlFor="accountReference">Account Reference</Label>
                <Input
                  id="accountReference"
                  value={accountReference}
                  onChange={(e) => setAccountReference(e.target.value)}
                  placeholder="e.g., INV-001 or CompanyName"
                />
                <p className="text-xs text-muted-foreground">
                  Shows on customer's M-Pesa statement
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
                  setPasskey("");
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
                  {maskValue((mpesaConfig?.config as MpesaConfig)?.consumer_key || "")}
                </p>
              </div>
              <div className="p-3 bg-muted/50 rounded-lg">
                <p className="text-sm font-medium">Business Short Code</p>
                <p className="text-sm text-muted-foreground font-mono">
                  {(mpesaConfig?.config as MpesaConfig)?.business_short_code || "Not set"}
                </p>
              </div>
            </div>

            {mpesaConfig?.callback_url && (
              <div className="p-3 bg-muted/50 rounded-lg">
                <div className="flex items-center justify-between">
                  <div>
                    <p className="text-sm font-medium">Callback URL</p>
                    <p className="text-sm text-muted-foreground font-mono break-all">
                      {mpesaConfig.callback_url}
                    </p>
                  </div>
                  <Button variant="ghost" size="icon" onClick={handleCopyCallback}>
                    <Copy className="h-4 w-4" />
                  </Button>
                </div>
                <p className="text-xs text-muted-foreground mt-1">
                  Add this URL to your Daraja app's callback settings
                </p>
              </div>
            )}

            {mpesaConfig?.test_error && (
              <div className="p-3 bg-destructive/10 text-destructive rounded-lg text-sm">
                <p className="font-medium">Last test error:</p>
                <p>{mpesaConfig.test_error}</p>
              </div>
            )}

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t">
              <div className="flex items-center gap-2">
                <Switch
                  checked={mpesaConfig?.is_active || false}
                  onCheckedChange={(checked) => toggleProviderActive("mpesa", checked)}
                />
                <Label>Enable M-Pesa payments</Label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button 
                  variant="outline"
                  size="sm"
                  onClick={handleTest}
                  disabled={isTesting}
                >
                  {isTesting && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                  Test Connection
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
                      <AlertDialogTitle>Remove M-Pesa Configuration?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will delete your M-Pesa API credentials. You will no longer
                        be able to receive M-Pesa payments until you reconfigure.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={() => deleteProviderConfig("mpesa")}
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
