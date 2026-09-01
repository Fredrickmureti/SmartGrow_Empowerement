/**
 * Microfinance loan products with immutable versions (C4).
 *
 * A product is the marketable identity (code, name, status). Its commercial
 * terms live in versions. A published version is frozen by a database trigger,
 * so loans already written on it never change when the product is repriced —
 * repricing means publishing a new version, never editing an old one.
 *
 * No pricing maths happens here: the schedule engine (C6) derives money
 * server-side from the version a loan snapshots.
 */
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";

export type MfProductStatus = "draft" | "active" | "retired";

export const MF_PRODUCT_STATUSES: MfProductStatus[] = ["draft", "active", "retired"];

export type MfRepaymentFrequency = "daily" | "weekly" | "biweekly" | "monthly";

export const MF_REPAYMENT_FREQUENCIES: MfRepaymentFrequency[] = [
  "daily",
  "weekly",
  "biweekly",
  "monthly",
];

export type MfInterestMethod =
  | "flat"
  | "declining_balance"
  | "declining_balance_equal_installments";

export const MF_INTEREST_METHODS: MfInterestMethod[] = [
  "flat",
  "declining_balance",
  "declining_balance_equal_installments",
];

export type MfInterestRatePeriod =
  | "per_annum"
  | "per_month"
  | "per_installment"
  | "flat_on_principal";

export const MF_INTEREST_RATE_PERIODS: MfInterestRatePeriod[] = [
  "per_annum",
  "per_month",
  "per_installment",
  "flat_on_principal",
];

export type MfPenaltyBasis =
  | "overdue_installment"
  | "overdue_principal"
  | "outstanding_balance";

export const MF_PENALTY_BASES: MfPenaltyBasis[] = [
  "overdue_installment",
  "overdue_principal",
  "outstanding_balance",
];

/** A product fee as configured on a version. Charged by the C6 engine. */
export interface MfProductFee {
  name: string;
  /** Percentage of the disbursed principal, or a flat amount. */
  basis: "percent_of_principal" | "fixed";
  value: number;
  /** When the fee is charged. */
  timing: "on_disbursement" | "on_first_installment";
}

/** Eligibility rules evaluated at application time (C5). */
export interface MfProductEligibility {
  min_completed_cycles?: number;
  max_completed_cycles?: number;
  min_age?: number;
  max_age?: number;
  requires_group_membership?: boolean;
  notes?: string;
}

export interface MfLoanProduct {
  id: string;
  business_id: string;
  code: string;
  name: string;
  description: string | null;
  status: MfProductStatus;
  current_version_id: string | null;
  created_at: string;
  updated_at: string;
}

export interface MfLoanProductVersion {
  id: string;
  business_id: string;
  product_id: string;
  version_no: number;
  currency_code: string;
  min_amount: number;
  max_amount: number;
  min_term_installments: number;
  max_term_installments: number;
  repayment_frequency: MfRepaymentFrequency;
  interest_method: MfInterestMethod;
  interest_rate: number;
  interest_rate_period: MfInterestRatePeriod;
  grace_period_installments: number;
  fees: MfProductFee[];
  penalty_rate: number;
  penalty_basis: MfPenaltyBasis;
  eligibility: MfProductEligibility;
  effective_from: string;
  is_published: boolean;
  published_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface MfLoanProductInput {
  code: string;
  name: string;
  description?: string | null;
  status?: MfProductStatus;
}

export type MfLoanProductVersionInput = Omit<
  MfLoanProductVersion,
  | "id"
  | "business_id"
  | "version_no"
  | "published_at"
  | "created_at"
  | "updated_at"
  | "is_published"
> & { is_published?: boolean };

const PRODUCT_SELECT =
  "id,business_id,code,name,description,status,current_version_id,created_at,updated_at";

const VERSION_SELECT =
  "id,business_id,product_id,version_no,currency_code,min_amount,max_amount,min_term_installments,max_term_installments,repayment_frequency,interest_method,interest_rate,interest_rate_period,grace_period_installments,fees,penalty_rate,penalty_basis,eligibility,effective_from,is_published,published_at,created_at,updated_at";

function friendly(error: unknown, fallback: string): string {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (/immutable/i.test(msg)) {
    return "That version is published and cannot be changed — publish a new version instead.";
  }
  if (/cannot be deleted/i.test(msg)) {
    return "Published versions are part of the loan record and cannot be deleted.";
  }
  if (/mf_loan_products_code_uniq|duplicate key/i.test(msg)) {
    return "A product with that code already exists.";
  }
  if (/mf_lpv_amount_chk/i.test(msg)) {
    return "The maximum amount must be at least the minimum, and both must be above zero.";
  }
  if (/mf_lpv_term_chk/i.test(msg)) {
    return "The maximum term must be at least the minimum, and both must be above zero.";
  }
  if (/row-level security/i.test(msg)) {
    return "You do not have permission to change loan products.";
  }
  return msg || fallback;
}

export function useMfLoanProducts(options?: { status?: MfProductStatus | "all" }) {
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const queryClient = useQueryClient();
  const status = options?.status ?? "all";

  const query = useQuery({
    queryKey: ["mf-loan-products", businessId, status],
    queryFn: async () => {
      if (!businessId) return [] as MfLoanProduct[];
      let q = supabase
        .from("mf_loan_products")
        .select(PRODUCT_SELECT)
        .eq("business_id", businessId)
        .order("code", { ascending: true });
      if (status !== "all") q = q.eq("status", status);
      const { data, error } = await q;
      if (error) throw error;
      return (data ?? []) as MfLoanProduct[];
    },
    enabled: !!businessId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-loan-products"] });
    queryClient.invalidateQueries({ queryKey: ["mf-loan-product-versions"] });
  };

  const createProduct = useMutation({
    mutationFn: async (input: MfLoanProductInput) => {
      if (!businessId) throw new Error("No institution selected");
      const { data: auth } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("mf_loan_products")
        .insert({
          business_id: businessId,
          code: input.code,
          name: input.name,
          description: input.description ?? null,
          status: input.status ?? "draft",
          created_by: auth.user?.id ?? null,
        })
        .select(PRODUCT_SELECT)
        .single();
      if (error) throw error;
      return data as MfLoanProduct;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Product created");
    },
    onError: (e) => toast.error(friendly(e, "Could not create the product")),
  });

  const updateProduct = useMutation({
    mutationFn: async ({ id, ...patch }: Partial<MfLoanProductInput> & { id: string }) => {
      const { error } = await supabase.from("mf_loan_products").update(patch).eq("id", id);
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Product updated");
    },
    onError: (e) => toast.error(friendly(e, "Could not update the product")),
  });

  return {
    products: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    createProduct,
    updateProduct,
    businessId,
  };
}

/** Version history for one product, newest first. */
export function useMfLoanProductVersions(productId: string | null) {
  const queryClient = useQueryClient();

  const query = useQuery({
    queryKey: ["mf-loan-product-versions", productId],
    queryFn: async () => {
      if (!productId) return [] as MfLoanProductVersion[];
      const { data, error } = await supabase
        .from("mf_loan_product_versions")
        .select(VERSION_SELECT)
        .eq("product_id", productId)
        .order("version_no", { ascending: false });
      if (error) throw error;
      return (data ?? []) as unknown as MfLoanProductVersion[];
    },
    enabled: !!productId,
  });

  const invalidate = () => {
    queryClient.invalidateQueries({ queryKey: ["mf-loan-product-versions"] });
    queryClient.invalidateQueries({ queryKey: ["mf-loan-products"] });
  };

  /**
   * Publishing is atomic from the operator's point of view: the version row is
   * inserted already published and becomes the product's version in force.
   */
  const publishVersion = useMutation({
    mutationFn: async (input: {
      businessId: string;
      version: MfLoanProductVersionInput;
      activateProduct?: boolean;
    }) => {
      if (!productId) throw new Error("No product selected");
      const { data: auth } = await supabase.auth.getUser();
      const { data, error } = await supabase
        .from("mf_loan_product_versions")
        .insert({
          ...input.version,
          fees: input.version.fees as unknown as never,
          eligibility: input.version.eligibility as unknown as never,
          business_id: input.businessId,
          product_id: productId,
          is_published: true,
          created_by: auth.user?.id ?? null,
        })
        .select("id")
        .single();
      if (error) throw error;

      const { error: linkError } = await supabase
        .from("mf_loan_products")
        .update({
          current_version_id: (data as { id: string }).id,
          ...(input.activateProduct ? { status: "active" } : {}),
        })
        .eq("id", productId);
      if (linkError) throw linkError;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Version published");
    },
    onError: (e) => toast.error(friendly(e, "Could not publish the version")),
  });

  return {
    versions: query.data ?? [],
    currentVersion: (query.data ?? []).find((v) => v.is_published) ?? null,
    isLoading: query.isLoading,
    error: query.error as Error | null,
    publishVersion,
  };
}

/** Next sequential product code, e.g. LP-0004. */
export function nextProductCode(existing: Array<{ code: string }>): string {
  let max = 0;
  for (const row of existing) {
    const m = /(\d+)\s*$/.exec(row.code ?? "");
    if (m) max = Math.max(max, Number(m[1]));
  }
  return `LP-${String(max + 1).padStart(4, "0")}`;
}
