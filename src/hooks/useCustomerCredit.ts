import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";
import { useBusinesses } from "./useBusinesses";
import { useCustomerOutstandingBalance } from "./useCustomerOutstandingBalance";
import { applyPartyScope } from "@/lib/contactAddresses";

export interface CustomerCreditInfo {
  customerId: string;
  creditLimit: number | null;
  creditHold: boolean;
  outstandingBalance: number;
  availableCredit: number | null;
  creditUtilization: number | null;
}

export function useCustomerCredit(customerId?: string) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  // ADR 0012 — derive the receivable position from the canonical hook so
  // credit-limit checks stay aligned with the Customer Deposits GL model.
  const { balance: outstandingBalance } = useCustomerOutstandingBalance(customerId);

  // Get customer's outstanding balance from unpaid invoices
  const { data: creditInfo, isLoading, refetch } = useQuery({
    queryKey: [
      "customer-credit",
      customerId,
      currentOrg?.id,
      currentBusiness?.id,
      outstandingBalance?.netReceivable ?? null,
    ],
    queryFn: async (): Promise<CustomerCreditInfo | null> => {
      if (!customerId || !currentOrg?.id || !currentBusiness?.id) return null;

      // Fetch contact with credit fields
      const { data: contact, error: contactError } = await supabase
        .from("contacts")
        .select("credit_limit, credit_hold")
        .eq("id", customerId)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .single();

      if (contactError) throw contactError;

      // Net receivable (open invoices − unapplied cash − unapplied credit
      // notes). When the canonical hook hasn't resolved yet, fall back to
      // 0 so credit checks fail safe (limit appears fully available rather
      // than blocking the user on a transient state).
      const netReceivable = outstandingBalance?.netReceivable ?? 0;
      const safeOutstanding = Math.max(0, netReceivable);

      const creditLimit = contact?.credit_limit as number | null;
      const creditHold = contact?.credit_hold as boolean ?? false;
      
      const availableCredit = creditLimit !== null 
        ? Math.max(0, creditLimit - safeOutstanding) 
        : null;
      
      const creditUtilization = creditLimit !== null && creditLimit > 0
        ? Math.min(100, (safeOutstanding / creditLimit) * 100)
        : null;

      return {
        customerId,
        creditLimit,
        creditHold,
        outstandingBalance: safeOutstanding,
        availableCredit,
        creditUtilization,
      };
    },
    enabled: !!customerId && !!currentOrg?.id && !!currentBusiness?.id,
  });

  // Check if a new order amount would exceed credit
  const checkCreditAvailability = (orderAmount: number): { 
    allowed: boolean; 
    reason?: string;
    availableCredit: number | null;
  } => {
    if (!creditInfo) {
      return { allowed: true, availableCredit: null };
    }

    if (creditInfo.creditHold) {
      return { 
        allowed: false, 
        reason: "Customer is on credit hold",
        availableCredit: 0,
      };
    }

    if (creditInfo.creditLimit === null) {
      // No credit limit set - unlimited
      return { allowed: true, availableCredit: null };
    }

    if (orderAmount > (creditInfo.availableCredit ?? 0)) {
      return {
        allowed: false,
        reason: `Order exceeds available credit. Available: ${creditInfo.availableCredit?.toFixed(2)}`,
        availableCredit: creditInfo.availableCredit,
      };
    }

    return { 
      allowed: true, 
      availableCredit: creditInfo.availableCredit,
    };
  };

  return {
    creditInfo,
    isLoading,
    refetch,
    checkCreditAvailability,
    isOnCreditHold: creditInfo?.creditHold ?? false,
  };
}

// Hook to get customers approaching credit limit for dashboard widget
export function useCustomersNearCreditLimit(threshold: number = 80) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  const { data: customersNearLimit = [], isLoading } = useQuery({
    queryKey: ["customers-near-credit-limit", currentOrg?.id, currentBusiness?.id, threshold],
    queryFn: async () => {
      if (!currentOrg?.id || !currentBusiness?.id) return [];

      // Get all customers with credit limits — scoped to current business
      const { data: contacts, error: contactsError } = await applyPartyScope(
        supabase
          .from("contacts")
          .select("id, name, credit_limit, credit_hold"),
      )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .not("credit_limit", "is", null)
        .eq("is_active", true);

      if (contactsError) throw contactsError;
      if (!contacts.length) return [];

      // Get outstanding balances for these customers — scoped to current business
      const { data: invoices, error: invoicesError } = await supabase
        .from("invoices")
        .select("contact_id, total, amount_paid")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .in("contact_id", contacts.map(c => c.id))
        .in("status", ["sent", "overdue", "partial"]);

      if (invoicesError) throw invoicesError;

      // Calculate balances per customer
      const balanceByCustomer: Record<string, number> = {};
      for (const inv of invoices) {
        if (!inv.contact_id) continue;
        balanceByCustomer[inv.contact_id] = 
          (balanceByCustomer[inv.contact_id] || 0) + (inv.total - (inv.amount_paid || 0));
      }

      // Filter customers near limit
      return contacts
        .map(contact => {
          const creditLimit = contact.credit_limit as number;
          const balance = balanceByCustomer[contact.id] || 0;
          const utilization = creditLimit > 0 ? (balance / creditLimit) * 100 : 0;
          
          return {
            id: contact.id,
            name: contact.name,
            creditLimit,
            outstandingBalance: balance,
            availableCredit: Math.max(0, creditLimit - balance),
            utilization,
            isOnHold: contact.credit_hold as boolean,
          };
        })
        .filter(c => c.utilization >= threshold || c.isOnHold)
        .sort((a, b) => b.utilization - a.utilization);
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
  });

  return { customersNearLimit, isLoading };
}
