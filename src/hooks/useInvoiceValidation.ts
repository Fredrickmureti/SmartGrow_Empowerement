/**
 * Invoice Validation and Integrity Hooks
 * 
 * Provides real-time validation and data integrity checking for invoices
 * to prevent financial mismatches and ensure GL consistency.
 */

import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";

interface InvoiceIntegrityIssue {
  invoice_id: string;
  invoice_number: string;
  status: string;
  total: number;
  amount_paid: number | null;
  journal_entry_id: string | null;
  issue_type: string;
  description: string;
}

interface InvoiceIntegrityReport {
  issues: InvoiceIntegrityIssue[];
  totalAffectedAmount: number;
  issueCount: number;
  hasIssues: boolean;
}

/**
 * Hook to check for invoice-journal integrity mismatches across the organization
 */
export function useInvoiceIntegrityCheck() {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();

  return useQuery({
    queryKey: ["invoice-integrity-check", currentOrg?.id, currentBusiness?.id],
    queryFn: async (): Promise<InvoiceIntegrityReport> => {
      if (!currentOrg?.id || !currentBusiness?.id) {
        return { issues: [], totalAffectedAmount: 0, issueCount: 0, hasIssues: false };
      }

      // Check for common integrity issues
      const { data: invoices, error } = await supabase
        .from("invoices")
        .select("id, invoice_number, status, total, amount_paid, journal_entry_id")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .in("status", ["paid", "partial"]);

      if (error) throw error;

      const issues: InvoiceIntegrityIssue[] = [];

      for (const invoice of invoices || []) {
        // Issue 1: Invoice marked as paid/partial but no journal entry
        if ((invoice.status === "paid" || invoice.status === "partial") && !invoice.journal_entry_id) {
          issues.push({
            invoice_id: invoice.id,
            invoice_number: invoice.invoice_number,
            status: invoice.status,
            total: invoice.total,
            amount_paid: invoice.amount_paid,
            journal_entry_id: invoice.journal_entry_id,
            issue_type: "missing_journal_entry",
            description: `Invoice ${invoice.invoice_number} is marked as ${invoice.status} but has no linked journal entry`,
          });
        }

        // Issue 2: Amount paid doesn't match expected for status
        if (invoice.status === "paid" && (invoice.amount_paid || 0) < invoice.total) {
          issues.push({
            invoice_id: invoice.id,
            invoice_number: invoice.invoice_number,
            status: invoice.status,
            total: invoice.total,
            amount_paid: invoice.amount_paid,
            journal_entry_id: invoice.journal_entry_id,
            issue_type: "payment_amount_mismatch",
            description: `Invoice ${invoice.invoice_number} marked as paid but amount_paid (${invoice.amount_paid}) < total (${invoice.total})`,
          });
        }
      }

      const totalAffectedAmount = issues.reduce((sum, issue) => sum + issue.total, 0);

      return {
        issues,
        totalAffectedAmount,
        issueCount: issues.length,
        hasIssues: issues.length > 0,
      };
    },
    enabled: !!currentOrg?.id && !!currentBusiness?.id,
    refetchOnWindowFocus: false,
    staleTime: 5 * 60 * 1000, // 5 minutes
  });
}

/**
 * Validates if an invoice can be transitioned to a specific status
 */
export function useInvoiceValidation() {
  const validateStatusChange = async (
    invoiceId: string, 
    newStatus: string,
    organizationId: string,
    businessId?: string
  ): Promise<{ isValid: boolean; error?: string }> => {
    if (newStatus === "paid" || newStatus === "partial") {
      // Check if journal entry exists and is posted
      let q = supabase
        .from("invoices")
        .select("journal_entry_id, journal_entries!fk_invoices_journal_entry_id(status)")
        .eq("id", invoiceId)
        .eq("organization_id", organizationId);
      q = q.eq("business_id", businessId);
      const { data: invoice, error } = await q.single();

      if (error) {
        return { isValid: false, error: "Failed to validate invoice status" };
      }

      if (!invoice?.journal_entry_id) {
        return { 
          isValid: false, 
          error: "Cannot mark invoice as paid/partial without a linked journal entry" 
        };
      }

      if (invoice?.journal_entries && (invoice.journal_entries as any)?.status !== "posted") {
        return { 
          isValid: false, 
          error: "Cannot mark invoice as paid/partial until journal entry is posted" 
        };
      }
    }

    return { isValid: true };
  };

  return { validateStatusChange };
}

/**
 * Validates batch operations on invoices
 */
export function validateBatchInvoiceOperation(
  invoices: Array<{ id: string; status: string; journal_entry_id?: string | null }>,
  operation: "delete" | "mark_paid" | "mark_sent"
): { isValid: boolean; errors: string[] } {
  const errors: string[] = [];

  for (const invoice of invoices) {
    if (operation === "mark_paid" && !invoice.journal_entry_id) {
      errors.push(`Invoice cannot be marked as paid without a journal entry`);
    }
    
    if (operation === "delete" && (invoice.status === "paid" || invoice.status === "partial")) {
      errors.push(`Cannot delete invoice that has been paid`);
    }
  }

  return {
    isValid: errors.length === 0,
    errors,
  };
}