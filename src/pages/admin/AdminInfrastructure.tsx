import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { EmailProviderSettings } from "@/components/admin/EmailProviderSettings";
import { BankProviderSettings } from "@/components/admin/BankProviderSettings";
import { AIProviderSettings } from "@/components/admin/AIProviderSettings";
import { ExchangeRateSettings } from "@/components/admin/ExchangeRateSettings";
import { PlatformPaymentProviderSettings } from "@/components/admin/PlatformPaymentProviderSettings";
import { MpesaEnvironmentSettings } from "@/components/admin/MpesaEnvironmentSettings";
import { DataIntegrityDiagnostics } from "@/components/admin/DataIntegrityDiagnostics";
import { IntegrationProviderManager } from "@/components/admin/IntegrationProviderManager";
import {
  Mail,
  Building2,
  Bot,
  ArrowRightLeft,
  Smartphone,
  ShieldCheck,
} from "lucide-react";

export default function AdminInfrastructure() {
  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold tracking-tight">
            Infrastructure
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            Configure email, banking, AI, payments, and currency providers
          </p>
        </div>

        <Tabs defaultValue="email" className="space-y-4 sm:space-y-6">
          <div className="overflow-x-auto scrollbar-hide -mx-3 px-3 sm:-mx-0 sm:px-0 pb-1">
            <TabsList className="inline-flex w-max gap-0.5 h-auto p-0.5 sm:p-1">
              <TabsTrigger value="email" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <Mail className="h-3.5 w-3.5 hidden sm:block" />
                Email
              </TabsTrigger>
              <TabsTrigger value="banking" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <Building2 className="h-3.5 w-3.5 hidden sm:block" />
                Banking
              </TabsTrigger>
              <TabsTrigger value="payments" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <Smartphone className="h-3.5 w-3.5 hidden sm:block" />
                Payments
              </TabsTrigger>
              <TabsTrigger value="ai" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <Bot className="h-3.5 w-3.5 hidden sm:block" />
                AI
              </TabsTrigger>
              <TabsTrigger value="currency" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <ArrowRightLeft className="h-3.5 w-3.5 hidden sm:block" />
                Currency
              </TabsTrigger>
              <TabsTrigger value="diagnostics" className="flex items-center gap-1.5 text-[10px] sm:text-xs lg:text-sm px-2 py-1.5 sm:px-3 sm:py-2 whitespace-nowrap">
                <ShieldCheck className="h-3.5 w-3.5 hidden sm:block" />
                Diagnostics
              </TabsTrigger>
            </TabsList>
          </div>

          <TabsContent value="email" className="space-y-6">
            <EmailProviderSettings />
          </TabsContent>

          <TabsContent value="banking" className="space-y-6">
            <BankProviderSettings />
          </TabsContent>

          <TabsContent value="payments" className="space-y-6">
            <PlatformPaymentProviderSettings />
            <MpesaEnvironmentSettings />
          </TabsContent>

          <TabsContent value="ai" className="space-y-6">
            <AIProviderSettings />
          </TabsContent>

          <TabsContent value="currency" className="space-y-6">
            <IntegrationProviderManager
              capabilityKey="exchange_rates"
              title="Live exchange-rate provider"
              description="Connect a live FX feed and use Fetch now to refresh USD-based rates. Periodic refresh is off by default — flip it on if you accept the API cost."
            />
            <ExchangeRateSettings />
          </TabsContent>

          <TabsContent value="diagnostics" className="space-y-6">
            <DataIntegrityDiagnostics />
          </TabsContent>
        </Tabs>
      </div>
    </>
  );
}
