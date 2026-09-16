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
import { useMemo } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { supabase } from "@/integrations/supabase/client";
import { useBusinesses } from "./useBusinesses";
import { lendingErrorMessage } from "@/lib/lending/lendingError";

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

export const MF_INTEREST_METHOD_LABELS: Record<MfInterestMethod, string> = {
  flat: "Flat",
  declining_balance: "Declining balance",
  declining_balance_equal_installments: "Declining balance (equal installments)",
};

export const MF_RATE_PERIOD_LABELS: Record<MfInterestRatePeriod, string> = {
  per_annum: "Per annum",
  per_month: "Per month",
  per_installment: "Per installment",
  flat_on_principal: "Flat on principal (whole loan)",
};

/**
 * How the schedule engine reads each basis. Shown next to the choice so the
 * operator prices deliberately instead of guessing.
 */
export const MF_RATE_PERIOD_HELP: Record<MfInterestRatePeriod, string> = {
  per_annum: "Annual rate, spread across the year by repayment frequency.",
  per_month: "Monthly rate, converted to the repayment frequency.",
  per_installment: "The rate is charged once per installment, with no conversion.",
  flat_on_principal:
    "The rate is charged once on the principal for the whole loan, whatever the term.",
};

/**
 * Mirrors the database constraint `mf_lpv_flat_basis_chk`: charging a single
 * whole-loan percentage only has a meaning for flat interest, because a
 * declining-balance schedule prices each period off the outstanding balance.
 */
export const MF_VALID_RATE_PERIODS: Record<MfInterestMethod, MfInterestRatePeriod[]> = {
  flat: ["per_annum", "per_month", "per_installment", "flat_on_principal"],
  declining_balance: ["per_annum", "per_month", "per_installment"],
  declining_balance_equal_installments: ["per_annum", "per_month", "per_installment"],
};

/**
 * When the interest on a loan is collected. Mirrors the database check on
 * `mf_loan_product_versions.interest_collection`, which also restricts upfront
 * collection to flat interest — a declining-balance schedule prices each period
 * off the outstanding balance, so its interest cannot be known at payout.
 */
export type MfInterestCollection = "with_installments" | "deducted_upfront";

export const MF_INTEREST_COLLECTIONS: MfInterestCollection[] = [
  "with_installments",
  "deducted_upfront",
];

export const MF_INTEREST_COLLECTION_LABELS: Record<MfInterestCollection, string> = {
  with_installments: "Collected with the installments",
  deducted_upfront: "Deducted upfront at disbursement",
};

export const MF_INTEREST_COLLECTION_HELP: Record<MfInterestCollection, string> = {
  with_installments:
    "Interest is charged across the repayment schedule and earned as repayments come in.",
  deducted_upfront:
    "The whole term's interest is taken out of the payout, so the client receives less cash and the schedule carries principal only. Flat interest only.",
};

/** Interest may only be taken upfront when the whole term is priced flat. */
export const MF_VALID_INTEREST_COLLECTIONS: Record<
  MfInterestMethod,
  MfInterestCollection[]
> = {
  flat: ["with_installments", "deducted_upfront"],
  declining_balance: ["with_installments"],
  declining_balance_equal_installments: ["with_installments"],
};

export const MF_PENALTY_BASIS_LABELS: Record<MfPenaltyBasis, string> = {
  overdue_installment: "Overdue installment total",
  overdue_principal: "Overdue principal",
  outstanding_balance: "Whole outstanding balance",
};


/**
 * A product fee as configured on a version. Field names mirror exactly what
 * `mf_compute_loan_fees` reads, so the server resolves the amounts and the
 * browser never computes a fee.
 */
export interface MfProductFee {
  name: string;
  /** Percentage of the loan principal, or a flat amount. */
  basis: "percent_of_principal" | "fixed";
  value: number;
  /** How the fee is collected. */
  collection:
    | "deducted_from_disbursement"
    | "added_to_first_installment"
    | "paid_at_disbursement";
}

export const MF_FEE_BASES: MfProductFee["basis"][] = ["percent_of_principal", "fixed"];

export const MF_FEE_BASIS_LABELS: Record<MfProductFee["basis"], string> = {
  percent_of_principal: "% of principal",
  fixed: "Flat amount",
};

export const MF_FEE_COLLECTIONS: MfProductFee["collection"][] = [
  "deducted_from_disbursement",
  "added_to_first_installment",
  "paid_at_disbursement",
];

export const MF_FEE_COLLECTION_LABELS: Record<MfProductFee["collection"], string> = {
  deducted_from_disbursement: "Deducted from disbursement",
  added_to_first_installment: "Added to first installment",
  paid_at_disbursement: "Paid by the client at disbursement",
};


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
  interest_collection: MfInterestCollection;
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
  "id,business_id,product_id,version_no,currency_code,min_amount,max_amount,min_term_installments,max_term_installments,repayment_frequency,interest_method,interest_rate,interest_rate_period,interest_collection,grace_period_installments,fees,penalty_rate,penalty_basis,eligibility,effective_from,is_published,published_at,created_at,updated_at";


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
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not create the product")),
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
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not update the product")),
  });

  /**
   * Stop offering a product while every past application and loan keeps the
   * pricing context that governed it. `mf_retire_loan_product` owns the rule.
   */
  const retireProduct = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("mf_retire_loan_product", { p_product_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Product retired");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "The product could not be retired")),
  });

  /**
   * Remove a product that was never published, never applied for and never
   * lent on. `mf_delete_loan_product` decides — the menu only asks.
   */
  const deleteProduct = useMutation({
    mutationFn: async (id: string) => {
      const { error } = await supabase.rpc("mf_delete_loan_product", { p_product_id: id });
      if (error) throw error;
    },
    onSuccess: () => {
      invalidate();
      toast.success("Product deleted");
    },
    onError: (e) => toast.error(lendingErrorMessage(e, "The product could not be deleted")),
  });

  return {
    products: query.data ?? [],
    isLoading: query.isLoading,
    error: query.error as Error | null,
    createProduct,
    updateProduct,
    retireProduct,
    deleteProduct,
    businessId,
  };
}

/**
 * Lookup of every product version in the institution by id, so a list can show
 * which version an application was actually priced on without loading each
 * product's history separately.
 */
export function useMfProductVersionIndex() {
  const query = useQuery({
    queryKey: ["mf-loan-product-versions", "index"],
    queryFn: async () => {
      const { data, error } = await supabase
        .from("mf_loan_product_versions")
        .select("id,product_id,version_no,currency_code");
      if (error) throw error;
      return (data ?? []) as Array<{
        id: string;
        product_id: string;
        version_no: number;
        currency_code: string;
      }>;
    },
  });

  const byId = useMemo(
    () => new Map((query.data ?? []).map((v) => [v.id, v])),
    [query.data],
  );

  return { versionsById: byId, isLoading: query.isLoading };
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
          // 0 is a sentinel: the database trigger assigns the next version number.
          version_no: 0,
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
    onError: (e) => toast.error(lendingErrorMessage(e, "Could not publish the version")),
  });

  return {
    versions: query.data ?? [],
    currentVersion: resolveVersionInForce(query.data ?? []),
    isLoading: query.isLoading,
    error: query.error as Error | null,
    publishVersion,
  };
}

/**
 * The version in force today: the published version whose effective date has
 * arrived, highest version number first. A version dated in the future is
 * scheduled, not live — it must never price a loan written before its date.
 */
export function resolveVersionInForce(
  versions: MfLoanProductVersion[],
): MfLoanProductVersion | null {
  const today = new Date().toISOString().slice(0, 10);
  const live = versions
    .filter((v) => v.is_published && (v.effective_from ?? "") <= today)
    .sort((a, b) => b.version_no - a.version_no);
  return live[0] ?? null;
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
