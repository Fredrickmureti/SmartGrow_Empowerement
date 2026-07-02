// @ts-nocheck
import { useState, useRef, useEffect } from "react";
import { motion, useInView } from "framer-motion";
import { Link } from "react-router-dom";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Check, Star } from "lucide-react";
import { fetchPublicPricingSnapshot } from "@/lib/pricing/publicPricing";
import { ScheduleDemoDialog } from "./ScheduleDemoDialog";
import { useAuth } from "@/contexts/AuthContext";
import { usePricingCurrency } from "@/hooks/usePricingCurrency";
import { PricingCurrencyToggle } from "@/components/pricing/PricingCurrencyToggle";

interface SubscriptionPlan {
  id: string;
  name: string;
  description: string | null;
  price_monthly: number;
  price_yearly: number | null;
  features: string[];
  is_popular: boolean;
}

export function PricingSection() {
  const ref = useRef<HTMLDivElement>(null);
  const isInView = useInView(ref, { once: true, margin: "-100px" });
  const [isYearly, setIsYearly] = useState(false);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showDemoDialog, setShowDemoDialog] = useState(false);
  const { user } = useAuth();
  const { displayCurrency, setDisplayCurrency, formatPrice, exchangeRate } = usePricingCurrency();

  useEffect(() => {
    const fetchPlans = async () => {
      try {
        const snapshot = await fetchPublicPricingSnapshot();
        const parsedPlans = snapshot.plans.map((plan) => ({
          ...plan,
          features: Array.isArray(plan.features)
            ? (plan.features as unknown[]).map((f) => String(f))
            : [],
        }));
        setPlans(parsedPlans);
      } catch (error) {
        console.error("Error fetching plans:", error);
      } finally {
        setIsLoading(false);
      }
    };

    fetchPlans();
  }, []);


  const getPrice = (plan: SubscriptionPlan) => {
    // USD is the single source of truth. KES (or any other display currency)
    // is converted live by `usePricingCurrency`'s exchange-rate lookup.
    const usdPrice = isYearly && plan.price_yearly
      ? Math.round(plan.price_yearly / 12)
      : plan.price_monthly;
    return formatPrice(usdPrice, null);
  };

  const getSavings = (plan: SubscriptionPlan) => {
    if (plan.price_yearly && plan.price_monthly > 0) {
      const yearlyCost = plan.price_yearly;
      const monthlyCost = plan.price_monthly * 12;
      const savings = Math.round(((monthlyCost - yearlyCost) / monthlyCost) * 100);
      return savings > 0 ? savings : 0;
    }
    return 0;
  };

  return (
    <section id="pricing" ref={ref} className="py-24 bg-muted/30">
      <div className="container mx-auto px-4">
        {/* Section Header */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6 }}
          className="text-center max-w-3xl mx-auto mb-16"
        >
          <h2 className="text-3xl md:text-4xl font-bold mb-4">
            Simple, Transparent{" "}
            <span className="text-transparent bg-clip-text bg-gradient-to-r from-purple-500 to-cyan-500">
              Pricing
            </span>
          </h2>
          <p className="text-lg text-muted-foreground mb-8">
            Choose the perfect plan for your business. All plans include a 14-day free trial.
          </p>

          {/* Billing Toggle and Currency Selector */}
          <div className="flex flex-col sm:flex-row items-center justify-center gap-4 sm:gap-8">
            <div className="flex items-center gap-4">
              <span className={`text-sm ${!isYearly ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                Monthly
              </span>
              <Switch
                checked={isYearly}
                onCheckedChange={setIsYearly}
              />
              <span className={`text-sm ${isYearly ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                Yearly
              </span>
              {isYearly && (
                <Badge variant="secondary" className="bg-green-100 text-green-700 dark:bg-green-900 dark:text-green-300">
                  Save up to 17%
                </Badge>
              )}
            </div>
            <PricingCurrencyToggle
              displayCurrency={displayCurrency}
              onCurrencyChange={setDisplayCurrency}
            />
          </div>
        </motion.div>

        {/* Pricing Cards */}
        {isLoading ? (
          <div className="flex justify-center py-12">
            <div className="animate-spin rounded-full h-8 w-8 border-b-2 border-primary" />
          </div>
        ) : (
          <div className="grid md:grid-cols-2 lg:grid-cols-4 gap-6 max-w-7xl mx-auto">
            {plans.map((plan, index) => (
              <motion.div
                key={plan.id}
                initial={{ opacity: 0, y: 30 }}
                animate={isInView ? { opacity: 1, y: 0 } : {}}
                transition={{ duration: 0.5, delay: index * 0.1 }}
                className={`relative rounded-2xl border bg-card p-6 ${
                  plan.is_popular
                    ? "border-primary shadow-xl shadow-primary/10 scale-105"
                    : "hover:border-primary/50 hover:shadow-lg"
                } transition-all duration-300`}
              >
                {plan.is_popular && (
                  <div className="absolute -top-3 left-1/2 -translate-x-1/2">
                    <Badge className="bg-gradient-to-r from-purple-500 to-cyan-500 text-white border-0">
                      <Star className="h-3 w-3 mr-1 fill-current" />
                      Most Popular
                    </Badge>
                  </div>
                )}

                <div className="text-center mb-6">
                  <h3 className="text-xl font-bold mb-2">{plan.name}</h3>
                  {plan.description && (
                    <p className="text-sm text-muted-foreground">{plan.description}</p>
                  )}
                </div>

                <div className="text-center mb-6">
                  <div className="flex items-baseline justify-center gap-1">
                    <span className="text-4xl font-bold">{getPrice(plan).primary}</span>
                    <span className="text-muted-foreground">/mo</span>
                  </div>
                  {getPrice(plan).secondary && (
                    <p className="text-sm text-muted-foreground mt-1">
                      {getPrice(plan).secondary}
                    </p>
                  )}
                  {isYearly && getSavings(plan) > 0 && (
                    <p className="text-sm text-green-600 dark:text-green-400 mt-1">
                      Save {getSavings(plan)}% with yearly billing
                    </p>
                  )}
                </div>

                <ul className="space-y-3 mb-6">
                  {plan.features.map((feature, i) => (
                    <li key={i} className="flex items-start gap-3">
                      <Check className="h-5 w-5 text-green-500 flex-shrink-0 mt-0.5" />
                      <span className="text-sm text-muted-foreground">{feature}</span>
                    </li>
                  ))}
                </ul>

                <Button
                  className={`w-full ${
                    plan.is_popular
                      ? "bg-gradient-to-r from-purple-500 to-cyan-500 hover:from-purple-600 hover:to-cyan-600 text-white border-0"
                      : ""
                  }`}
                  variant={plan.is_popular ? "default" : "outline"}
                  asChild
                >
                  <Link to={user ? "/dashboard" : "/signup"}>
                    {user 
                      ? "Go to Dashboard" 
                      : (plan.price_monthly === 0 ? "Get Started Free" : "Start Free Trial")}
                  </Link>
                </Button>
              </motion.div>
            ))}
          </div>
        )}

        {/* Enterprise CTA */}
        <motion.div
          initial={{ opacity: 0, y: 20 }}
          animate={isInView ? { opacity: 1, y: 0 } : {}}
          transition={{ duration: 0.6, delay: 0.6 }}
          className="mt-16 text-center"
        >
          <p className="text-muted-foreground mb-4">
            Need a custom solution for your enterprise?
          </p>
          <Button variant="link" className="text-primary" onClick={() => setShowDemoDialog(true)}>
            Contact our sales team →
          </Button>
        </motion.div>
      </div>

      <ScheduleDemoDialog 
        open={showDemoDialog} 
        onOpenChange={setShowDemoDialog} 
      />
    </section>
  );
}
