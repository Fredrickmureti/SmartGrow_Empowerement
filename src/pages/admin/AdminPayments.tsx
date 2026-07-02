
import { SubscriptionMaintenanceCard } from "@/components/admin/SubscriptionMaintenanceCard";
import { SubscriptionPaymentsCard } from "@/components/admin/SubscriptionPaymentsCard";

export default function AdminPayments() {
  return (
    <>
      <div className="p-3 sm:p-6 lg:p-8 space-y-4 sm:space-y-6">
        <div>
          <h1 className="text-lg sm:text-xl lg:text-2xl font-bold tracking-tight">
            Payments & Billing
          </h1>
          <p className="text-xs sm:text-sm text-muted-foreground">
            View payment history, maintenance tasks, and billing overview
          </p>
        </div>
        <SubscriptionMaintenanceCard />
        <SubscriptionPaymentsCard />
      </div>
    </>
  );
}
