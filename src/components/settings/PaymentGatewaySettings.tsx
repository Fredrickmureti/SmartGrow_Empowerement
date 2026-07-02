import { useState } from "react";
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
import { Badge } from "@/components/ui/badge";
import { usePaymentGateway } from "@/hooks/usePaymentGateway";
import { Loader2, CreditCard, Eye, EyeOff, Trash2, ExternalLink, AlertTriangle } from "lucide-react";

export function PaymentGatewaySettings() {
  const { gateway, isLoading, isSaving, saveGateway, toggleActive, deleteGateway } = usePaymentGateway();
  
  const [publishableKey, setPublishableKey] = useState("");
  const [secretKey, setSecretKey] = useState("");
  const [isTestMode, setIsTestMode] = useState(true);
  const [showSecretKey, setShowSecretKey] = useState(false);
  const [isEditing, setIsEditing] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    
    if (!publishableKey || !secretKey) {
      return;
    }

    await saveGateway({
      publishableKey,
      secretKey,
      isTestMode,
    });

    setSecretKey("");
    setIsEditing(false);
  };

  const handleStartEditing = () => {
    if (gateway) {
      setPublishableKey(gateway.publishable_key || "");
      setIsTestMode(gateway.is_test_mode);
    }
    setIsEditing(true);
  };

  const maskKey = (key: string) => {
    if (!key) return "";
    if (key.length <= 8) return "••••••••";
    return key.substring(0, 7) + "•".repeat(20) + key.substring(key.length - 4);
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
            <div className="h-10 w-10 rounded-lg bg-[#635BFF] flex items-center justify-center flex-shrink-0">
              <CreditCard className="h-5 w-5 text-white" />
            </div>
            <div>
              <CardTitle className="text-base sm:text-lg">Stripe Payment Gateway</CardTitle>
              <CardDescription>
                Accept online payments directly to your Stripe account
              </CardDescription>
            </div>
          </div>
          {gateway && (
            <div className="flex items-center gap-2 flex-wrap">
              <Badge variant={gateway.is_test_mode ? "secondary" : "default"}>
                {gateway.is_test_mode ? "Test Mode" : "Live"}
              </Badge>
              <Badge variant={gateway.is_active ? "default" : "outline"}>
                {gateway.is_active ? "Active" : "Inactive"}
              </Badge>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent>
        {!gateway && !isEditing ? (
          <div className="text-center py-6 space-y-4">
            <div className="bg-muted/50 rounded-lg p-6">
              <h3 className="font-medium mb-2">Connect Your Stripe Account</h3>
              <p className="text-sm text-muted-foreground mb-4">
                Enter your Stripe API keys to enable online invoice payments. 
                Payments will go directly to your Stripe account - we never hold your funds.
              </p>
              <Button onClick={() => setIsEditing(true)}>
                <CreditCard className="mr-2 h-4 w-4" />
                Connect Stripe
              </Button>
            </div>
            <a
              href="https://dashboard.stripe.com/apikeys"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline inline-flex items-center gap-1"
            >
              Get your API keys from Stripe Dashboard
              <ExternalLink className="h-3 w-3" />
            </a>
          </div>
        ) : isEditing ? (
          <form onSubmit={handleSubmit} className="space-y-4">
            <div className="bg-amber-50 dark:bg-amber-950/30 border border-amber-200 dark:border-amber-900 rounded-lg p-3 flex items-start gap-2">
              <AlertTriangle className="h-4 w-4 text-amber-600 mt-0.5 flex-shrink-0" />
              <div className="text-sm text-amber-800 dark:text-amber-200">
                <p className="font-medium">Keep your secret key secure</p>
                <p className="text-amber-700 dark:text-amber-300">
                  Your secret key grants full access to your Stripe account. Never share it publicly.
                </p>
              </div>
            </div>

            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Label htmlFor="testMode">Test Mode</Label>
                <Switch
                  id="testMode"
                  checked={isTestMode}
                  onCheckedChange={setIsTestMode}
                />
              </div>
              <span className="text-sm text-muted-foreground">
                {isTestMode ? "Using test API keys" : "Using live API keys"}
              </span>
            </div>

            <div className="space-y-2">
              <Label htmlFor="publishableKey">
                {isTestMode ? "Test" : "Live"} Publishable Key
              </Label>
              <Input
                id="publishableKey"
                value={publishableKey}
                onChange={(e) => setPublishableKey(e.target.value)}
                placeholder={isTestMode ? "pk_test_..." : "pk_live_..."}
                required
              />
              <p className="text-xs text-muted-foreground">
                Starts with {isTestMode ? "pk_test_" : "pk_live_"}
              </p>
            </div>

            <div className="space-y-2">
              <Label htmlFor="secretKey">
                {isTestMode ? "Test" : "Live"} Secret Key
              </Label>
              <div className="relative">
                <Input
                  id="secretKey"
                  type={showSecretKey ? "text" : "password"}
                  value={secretKey}
                  onChange={(e) => setSecretKey(e.target.value)}
                  placeholder={isTestMode ? "sk_test_..." : "sk_live_..."}
                  required
                  className="pr-10"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="absolute right-0 top-0 h-full px-3"
                  onClick={() => setShowSecretKey(!showSecretKey)}
                >
                  {showSecretKey ? (
                    <EyeOff className="h-4 w-4 text-muted-foreground" />
                  ) : (
                    <Eye className="h-4 w-4 text-muted-foreground" />
                  )}
                </Button>
              </div>
              <p className="text-xs text-muted-foreground">
                Starts with {isTestMode ? "sk_test_" : "sk_live_"}
              </p>
            </div>

            <div className="flex gap-2 pt-2">
              <Button type="submit" disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Credentials
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setIsEditing(false);
                  setPublishableKey("");
                  setSecretKey("");
                }}
              >
                Cancel
              </Button>
            </div>
          </form>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-4">
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="text-sm font-medium">Publishable Key</p>
                  <p className="text-sm text-muted-foreground font-mono">
                    {maskKey(gateway?.publishable_key || "")}
                  </p>
                </div>
              </div>
              <div className="flex items-center justify-between p-3 bg-muted/50 rounded-lg">
                <div>
                  <p className="text-sm font-medium">Secret Key</p>
                  <p className="text-sm text-muted-foreground font-mono">
                    ••••••••••••••••••••
                  </p>
                </div>
              </div>
            </div>

            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pt-4 border-t">
              <div className="flex items-center gap-2">
                <Switch
                  checked={gateway?.is_active || false}
                  onCheckedChange={(checked) => toggleActive(checked)}
                />
                <Label>Enable online payments</Label>
              </div>
              <div className="flex flex-wrap gap-2">
                <Button variant="outline" size="sm" onClick={handleStartEditing}>
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
                      <AlertDialogTitle>Remove Stripe Connection?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This will delete your Stripe API keys. Customers will no longer
                        be able to pay invoices online until you reconnect.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        onClick={deleteGateway}
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
