import { useState, useEffect } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";
import { PlatformAppLayout } from "@/apps/platform";
import { useSubscriptionPlans } from "@/hooks/useSubscriptionPlans";
import { useSubscription } from "@/hooks/useSubscription";
import { useOrganization } from "@/hooks/useOrganization";
import { useSession } from "@/contexts/SessionContext";
import { usePlatformPaymentProviders } from "@/hooks/usePlatformPaymentProviders";
import { usePricingCurrency } from "@/hooks/usePricingCurrency";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardFooter,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { useToast } from "@/hooks/use-toast";
import { Check, Loader2, Sparkles, Mail, ArrowLeft, Users, AlertCircle, Settings as SettingsIcon } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { PaymentMethodSelector, PaymentProvider } from "@/components/checkout/PaymentMethodSelector";
import { PricingCurrencyToggle } from "@/components/pricing/PricingCurrencyToggle";
import { usePlatformIdentity } from "@/contexts/PlatformIdentityContext";
import { normalizeError } from "@/services/resilience";

export default function Upgrade() {
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const { toast } = useToast();
  const { activePlans, isLoading: plansLoading } = useSubscriptionPlans();
  const { plan: currentPlan, subscriptionStatus } = useSubscription();
  const { currentOrg } = useOrganization();
  const { refreshSession } = useSession();
  const { enabledProviders, isLoading: providersLoading } = usePlatformPaymentProviders();
  const { displayCurrency, setDisplayCurrency, formatPrice, exchangeRate } = usePricingCurrency();
  const { isPlatformAdmin } = usePlatformIdentity();
  
  const [selectedPlan, setSelectedPlan] = useState<any>(null);
  const [billingCycle, setBillingCycle] = useState<"monthly" | "yearly">("monthly");
  const [showPaymentModal, setShowPaymentModal] = useState(false);
  const [selectedProvider, setSelectedProvider] = useState<PaymentProvider | null>(null);
  const [phoneNumber, setPhoneNumber] = useState("");
  const [isProcessing, setIsProcessing] = useState(false);

  useEffect(() => {
    const sessionId = searchParams.get("session_id");
    const paypalOrderId = searchParams.get("token");
    
    if (sessionId || paypalOrderId) {
      toast({
        title: "Payment Processing",
        description: "Your payment is being verified. Your subscription will be activated shortly.",
      });
      
      if (paypalOrderId) {
        capturePayPalOrder(paypalOrderId);
      } else {
        const refreshTimer = setTimeout(async () => {
          await refreshSession();
          toast({
            title: "Subscription Activated",
            description: "Your plan has been upgraded successfully!",
          });
          navigate("/upgrade", { replace: true });
        }, 3000);
        return () => clearTimeout(refreshTimer);
      }
    }
  }, [searchParams]);

  const capturePayPalOrder = async (orderId: string) => {
    try {
      const response = await supabase.functions.invoke("paypal-orders", {
        body: { action: "capture", orderId },
      });
      if (response.error) throw response.error;
      await refreshSession();
      toast({ title: "Payment Successful", description: "Your subscription has been activated!" });
      navigate("/upgrade", { replace: true });
    } catch (error: any) {
      toast({ title: "Payment Error", description: normalizeError(error).message || "Failed to complete payment", variant: "destructive" });
    }
  };

  const handleSelectPlan = (plan: any) => {
    setSelectedPlan(plan);
    setShowPaymentModal(true);
  };

  const handleProceedToPayment = async () => {
    if (!selectedPlan || !selectedProvider || !currentOrg) return;

    setIsProcessing(true);
    try {
      const baseUrl = window.location.origin;
      
      switch (selectedProvider) {
        case "stripe": {
          const response = await supabase.functions.invoke("stripe-create-checkout", {
            body: {
              planId: selectedPlan.id,
              billingCycle,
              successUrl: `${baseUrl}/upgrade?session_id={CHECKOUT_SESSION_ID}`,
              cancelUrl: `${baseUrl}/upgrade`,
            },
          });
          if (response.error) throw new Error(response.error.message);
          if (!response.data?.url) throw new Error("No checkout URL received");
          window.location.href = response.data.url;
          return;
        }
        case "paypal": {
          const response = await supabase.functions.invoke("paypal-orders", {
            body: { action: "create", planId: selectedPlan.id, billingCycle, returnUrl: `${baseUrl}/upgrade`, cancelUrl: `${baseUrl}/upgrade` },
          });
          if (response.error) throw new Error(response.error.message);
          if (!response.data?.approvalUrl) throw new Error("No approval URL received");
          window.location.href = response.data.approvalUrl;
          return;
        }
        case "pesapal": {
          // pesapal function is path-routed; supabase-js invoke does not support
          // path segments, so call the create-order action via raw fetch.
          const { data: { session } } = await supabase.auth.getSession();
          const res = await fetch(
            `${import.meta.env.VITE_SUPABASE_URL}/functions/v1/pesapal/create-order`,
            {
              method: "POST",
              headers: {
                "Content-Type": "application/json",
                Authorization: `Bearer ${session?.access_token}`,
                apikey: import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY,
              },
              body: JSON.stringify({ planId: selectedPlan.id, billingCycle, callbackUrl: `${baseUrl}/upgrade/success` }),
            }
          );
          const data = await res.json();
          if (!res.ok) throw new Error(data?.error || "Failed to create PesaPal order");
          if (!data?.redirectUrl) throw new Error("No redirect URL received");
          window.location.href = data.redirectUrl;
          return;
        }
        case "mpesa": {
          if (!phoneNumber.trim()) throw new Error("Phone number is required for M-Pesa");
          const response = await supabase.functions.invoke("mpesa-outbound", {
            body: { action: "subscription_stk", planId: selectedPlan.id, billingCycle, phoneNumber: phoneNumber.trim() },
          });
          if (response.error) throw new Error(response.error.message);
          if (!response.data?.success) throw new Error(response.data?.error || "STK push failed");
          toast({ title: "M-Pesa Prompt Sent", description: "Check your phone and enter your M-Pesa PIN to complete payment" });
          setShowPaymentModal(false);
          pollMpesaStatus(response.data.paymentRequestId);
          return;
        }
      }
    } catch (error: any) {
      toast({ title: "Payment Error", description: normalizeError(error).message || "Failed to initiate payment", variant: "destructive" });
    } finally {
      setIsProcessing(false);
    }
  };

  const pollMpesaStatus = async (paymentRequestId: string) => {
    let attempts = 0;
    const maxAttempts = 30;
    const pollInterval = 3000;

    const poll = async () => {
      attempts++;
      const { data } = await supabase
        .from("payment_requests")
        .select("status, result_description")
        .eq("id", paymentRequestId)
        .single();

      if (data?.status === "completed") {
        await refreshSession();
        toast({ title: "Payment Successful", description: "Your subscription has been activated!" });
        navigate("/upgrade", { replace: true });
        return;
      }
      if (data?.status === "failed" || data?.status === "cancelled") {
        toast({ title: "Payment Failed", description: data.result_description || "Payment was not completed", variant: "destructive" });
        return;
      }
      if (attempts < maxAttempts) setTimeout(poll, pollInterval);
    };
    setTimeout(poll, pollInterval);
  };

  const handleContactSupport = () => {
    window.location.href = "mailto:support@yourdomain.com?subject=Subscription%20Inquiry";
  };

  const getDisplayPrice = (plan: any) => {
    // Single source of truth: USD price from the plan record. Display currency
    // (KES/USD) is converted at render time via the live exchange rate in
    // `usePricingCurrency` — the legacy `price_*_kes` columns are no longer
    // read so the system is Odoo-grade (plan price in plan.currency, FX live).
    const price = billingCycle === "yearly" ? plan.price_yearly : plan.price_monthly;
    return formatPrice(price, null);
  };

  const getPerUserPrice = (plan: any) => {
    const perUser = billingCycle === "yearly" 
      ? (plan.price_per_user_yearly ?? 0) 
      : (plan.price_per_user_monthly ?? 0);
    if (perUser <= 0) return null;
    return formatPrice(perUser, null);
  };

  if (plansLoading || providersLoading) {
    return (
      <PlatformAppLayout>
        <div className="flex items-center justify-center py-24">
          <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
        </div>
      </PlatformAppLayout>
    );
  }

  const availableProviders = enabledProviders
    .filter(p => p.is_enabled)
    .map(p => p.provider as PaymentProvider);

  return (
    <PlatformAppLayout>
      <div className="max-w-6xl mx-auto space-y-8">
        {/* Header */}
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-4">
            <Button variant="ghost" size="icon" onClick={() => navigate(-1)}>
              <ArrowLeft className="h-4 w-4" />
            </Button>
            <div>
              <h1 className="text-3xl font-bold">Upgrade Your Plan</h1>
              <p className="text-muted-foreground mt-1">
                Choose the plan that's right for your business
              </p>
            </div>
          </div>
          <PricingCurrencyToggle
            displayCurrency={displayCurrency}
            onCurrencyChange={setDisplayCurrency}
          />
        </div>

        {/* Billing Cycle Toggle */}
        <div className="flex justify-center">
          <div className="inline-flex items-center rounded-lg bg-muted p-1">
            <Button variant={billingCycle === "monthly" ? "default" : "ghost"} size="sm" onClick={() => setBillingCycle("monthly")}>
              Monthly
            </Button>
            <Button variant={billingCycle === "yearly" ? "default" : "ghost"} size="sm" onClick={() => setBillingCycle("yearly")}>
              Yearly
              <Badge variant="secondary" className="ml-2">Save 20%</Badge>
            </Button>
          </div>
        </div>

        {/* No payment provider configured — empty-state guard.
            Without this, clicking Subscribe would dead-end silently because the
            edge functions (stripe-create-checkout / pesapal-create-order) cannot
            run without enabled credentials. */}
        {availableProviders.length === 0 && (
          <Card className="border-amber-500/40 bg-amber-50/40 dark:bg-amber-950/20">
            <CardContent className="flex flex-col gap-3 py-5 sm:flex-row sm:items-start">
              <AlertCircle className="h-5 w-5 shrink-0 text-amber-600 dark:text-amber-400" />
              <div className="flex-1 space-y-2">
                <h3 className="font-semibold">Online payments are not yet enabled</h3>
                <p className="text-sm text-muted-foreground">
                  {isPlatformAdmin
                    ? "No payment providers are enabled. Add credentials and enable at least one provider (Stripe, Pesapal, M-Pesa, PayPal) before tenants can subscribe."
                    : "Your platform administrator hasn't enabled an online payment provider yet. Contact them to activate Stripe, Pesapal, M-Pesa or PayPal — or reach out to support to subscribe manually."}
                </p>
                <div className="flex flex-wrap gap-2 pt-1">
                  {isPlatformAdmin ? (
                    <Button size="sm" onClick={() => navigate("/admin/payments")}>
                      <SettingsIcon className="mr-1.5 h-3.5 w-3.5" />
                      Configure providers
                    </Button>
                  ) : (
                    <Button size="sm" variant="outline" onClick={handleContactSupport}>
                      <Mail className="mr-1.5 h-3.5 w-3.5" />
                      Contact support
                    </Button>
                  )}
                </div>
              </div>
            </CardContent>
          </Card>
        )}

        {/* Current Plan Banner */}
        {currentPlan && (
          <Card className="bg-primary/5 border-primary/20">
            <CardContent className="flex items-center justify-between py-4">
              <div className="flex items-center gap-3">
                <Sparkles className="h-5 w-5 text-primary" />
                <span className="font-medium">
                  Current Plan: <strong>{currentPlan.name}</strong>
                </span>
                {subscriptionStatus.isTrialing && <Badge variant="secondary">Trial</Badge>}
              </div>
              {subscriptionStatus.trialEndsAt && subscriptionStatus.isTrialing && (
                <span className="text-sm text-muted-foreground">
                  {Math.max(0, Math.ceil((new Date(subscriptionStatus.trialEndsAt).getTime() - Date.now()) / (1000 * 60 * 60 * 24)))} days remaining
                </span>
              )}
            </CardContent>
          </Card>
        )}

        {/* Plans Grid */}
        <div className="grid gap-6 md:grid-cols-2 lg:grid-cols-4">
          {activePlans.map((plan) => {
            const isCurrentPlan = currentPlan?.id === plan.id;
            const isUpgrade = currentPlan 
              ? plan.price_monthly > (currentPlan.price_monthly || 0)
              : true;
            const displayPrice = getDisplayPrice(plan);
            const perUserPrice = getPerUserPrice(plan);

            return (
              <Card 
                key={plan.id} 
                className={`relative flex flex-col ${plan.is_popular ? "border-primary shadow-lg" : ""} ${isCurrentPlan ? "bg-muted/30" : ""}`}
              >
                {plan.is_popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-primary text-primary-foreground">Most Popular</Badge>
                  </div>
                )}

                <CardHeader>
                  <CardTitle className="flex items-center justify-between">
                    {plan.name}
                    {isCurrentPlan && <Badge variant="secondary">Current</Badge>}
                  </CardTitle>
                  <CardDescription>{plan.description}</CardDescription>
                </CardHeader>

                <CardContent className="flex-1 space-y-6">
                  {/* Pricing */}
                  <div>
                    <div className="flex items-baseline gap-1">
                      <span className="text-3xl font-bold">
                        {displayPrice.primary === "Free" ? "Free" : displayPrice.primary}
                      </span>
                      {displayPrice.primary !== "Free" && (
                        <span className="text-muted-foreground">
                          /{billingCycle === "yearly" ? "year" : "month"}
                        </span>
                      )}
                    </div>
                    {perUserPrice && (
                      <div className="flex items-center gap-1.5 mt-1 text-sm text-muted-foreground">
                        <Users className="h-3.5 w-3.5" />
                        <span>+ {perUserPrice.primary}/user/{billingCycle === "yearly" ? "year" : "month"}</span>
                      </div>
                    )}
                    {displayPrice.secondary && displayPrice.primary !== "Free" && (
                      <p className="text-sm text-muted-foreground mt-1">{displayPrice.secondary}</p>
                    )}
                  </div>

                  {/* Limits */}
                  <div className="space-y-2 text-sm">
                    <div className="flex items-center gap-2">
                      <Check className="h-4 w-4 text-primary" />
                      <span>{plan.max_users === null ? "Unlimited" : plan.max_users} team members</span>
                    </div>
                    {plan.price_monthly > 0 && (
                      <div className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-primary" />
                        <span>Unlimited invoices</span>
                      </div>
                    )}
                    {plan.price_monthly === 0 && (
                      <div className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-primary" />
                        <span>50 invoices/month</span>
                      </div>
                    )}
                  </div>

                  {/* Features */}
                  <div className="space-y-2 text-sm">
                    {plan.features.slice(0, 6).map((feature, idx) => (
                      <div key={idx} className="flex items-center gap-2">
                        <Check className="h-4 w-4 text-primary" />
                        <span>{feature}</span>
                      </div>
                    ))}
                    {plan.features.length > 6 && (
                      <p className="text-muted-foreground">+{plan.features.length - 6} more</p>
                    )}
                  </div>
                </CardContent>

                <CardFooter>
                  {isCurrentPlan ? (
                    <Button className="w-full" variant="outline" disabled>Current Plan</Button>
                  ) : plan.price_monthly === 0 ? (
                    <Button className="w-full" variant="outline" disabled>Free Plan</Button>
                  ) : isUpgrade ? (
                    <Button className="w-full" onClick={() => handleSelectPlan(plan)} disabled={availableProviders.length === 0}>
                      Upgrade to {plan.name}
                    </Button>
                  ) : (
                    <Button className="w-full" variant="outline" onClick={() => handleSelectPlan(plan)} disabled={availableProviders.length === 0}>
                      Switch to {plan.name}
                    </Button>
                  )}
                </CardFooter>
              </Card>
            );
          })}
        </div>

        {/* No Payment Methods Warning */}
        {availableProviders.length === 0 && (
          <Card className="border-yellow-500/50 bg-yellow-500/5">
            <CardContent className="py-4 text-center">
              <p className="text-yellow-600 dark:text-yellow-400">
                No payment methods are currently configured. Please contact the administrator.
              </p>
            </CardContent>
          </Card>
        )}

        {/* Contact Section */}
        <Card>
          <CardContent className="flex items-center justify-between py-6">
            <div>
              <h3 className="font-semibold">Need a custom plan?</h3>
              <p className="text-sm text-muted-foreground">
                Contact us for enterprise pricing and custom features
              </p>
            </div>
            <Button variant="outline" onClick={handleContactSupport}>
              <Mail className="mr-2 h-4 w-4" />
              Contact Sales
            </Button>
          </CardContent>
        </Card>
      </div>

      {/* Payment Modal */}
      <Dialog open={showPaymentModal} onOpenChange={setShowPaymentModal}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Complete Your Upgrade</DialogTitle>
            <DialogDescription>
              {selectedPlan?.name} Plan - {billingCycle === "yearly" ? "Annual" : "Monthly"} billing
            </DialogDescription>
          </DialogHeader>
          
          {selectedPlan && (
            <PaymentMethodSelector
              enabledProviders={availableProviders}
              selectedProvider={selectedProvider}
              onSelectProvider={setSelectedProvider}
              phoneNumber={phoneNumber}
              onPhoneNumberChange={setPhoneNumber}
              isProcessing={isProcessing}
              onProceed={handleProceedToPayment}
              amount={getDisplayPrice(selectedPlan).primary.replace(/[^\d.,]/g, "")}
              currency={displayCurrency === "KES" ? "KSh" : "$"}
            />
          )}
        </DialogContent>
      </Dialog>
    </PlatformAppLayout>
  );
}
