import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { SubscriptionPlansSettings } from "@/components/admin/SubscriptionPlansSettings";
import { PlanEntitlementsMatrix } from "@/components/admin/PlanEntitlementsMatrix";
import { PlanComparisonMatrix } from "@/components/admin/PlanComparisonMatrix";
import { PlanPremiumFeatures } from "@/components/admin/PlanPremiumFeatures";
import { AppPricingRulesSettings } from "@/components/admin/AppPricingRulesSettings";
import { AppDependenciesMatrix } from "@/components/admin/AppDependenciesMatrix";
import {
  CreditCard,
  LayoutGrid,
  Sparkles,
  GitCompare,
  Tag,
  GitMerge,
} from "lucide-react";

export default function AdminPlanBuilder() {
  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold tracking-tight">
            Plan Builder
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Configure plans & pricing, control which apps each plan includes, manage premium features, and preview the customer-facing comparison
          </p>
        </div>

        <Tabs defaultValue="plans" className="space-y-4 sm:space-y-6">
          <div className="overflow-x-auto scrollbar-hide -mx-3 px-3 sm:-mx-0 sm:px-0 pb-1">
            <TabsList className="inline-flex w-max gap-0.5 h-auto p-0.5 sm:p-1">
              <TabsTrigger value="plans" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <CreditCard className="h-3.5 w-3.5 hidden sm:block" />
                Plans & Pricing
              </TabsTrigger>
              <TabsTrigger value="apps" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <LayoutGrid className="h-3.5 w-3.5 hidden sm:block" />
                App Packaging
              </TabsTrigger>
              <TabsTrigger value="pricing" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <Tag className="h-3.5 w-3.5 hidden sm:block" />
                App Pricing
              </TabsTrigger>
              <TabsTrigger value="dependencies" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <GitMerge className="h-3.5 w-3.5 hidden sm:block" />
                Dependencies
              </TabsTrigger>
              <TabsTrigger value="premium" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <Sparkles className="h-3.5 w-3.5 hidden sm:block" />
                Premium Features
              </TabsTrigger>
              <TabsTrigger value="matrix" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <GitCompare className="h-3.5 w-3.5 hidden sm:block" />
                Preview
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="plans" className="space-y-6">
            <SubscriptionPlansSettings />
          </TabsContent>

          <TabsContent value="apps" className="space-y-6">
            <PlanEntitlementsMatrix />
          </TabsContent>

          <TabsContent value="pricing" className="space-y-6">
            <AppPricingRulesSettings />
          </TabsContent>

          <TabsContent value="dependencies" className="space-y-6">
            <AppDependenciesMatrix />
          </TabsContent>

          <TabsContent value="premium" className="space-y-6">
            <PlanPremiumFeatures />
          </TabsContent>

          <TabsContent value="matrix" className="space-y-6">
            <PlanComparisonMatrix />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
