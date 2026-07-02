/**
 * Track C — Naming hygiene aliases.
 *
 * Several DB tables are prefixed `organization_*` for legacy reasons
 * (`organization_payment_methods`, `organization_payment_gateways`) but
 * are operationally scoped at the **business** (company) level — they
 * carry `business_id` and, in some cases, `branch_id`.
 *
 * Renaming the tables is high-risk (every edge function + migration
 * would need to move), so we keep the DB names but expose semantically
 * correct TypeScript aliases here. New code should import from this
 * module so the codebase reads as "company payment method" even though
 * the underlying table is `organization_payment_methods`.
 *
 * See `docs` in mem:// architecture audit for the full rationale.
 */
import type { Database } from "@/integrations/supabase/types";

export type CompanyPaymentMethodRow =
  Database["public"]["Tables"]["organization_payment_methods"]["Row"];
export type CompanyPaymentMethodInsert =
  Database["public"]["Tables"]["organization_payment_methods"]["Insert"];
export type CompanyPaymentMethodUpdate =
  Database["public"]["Tables"]["organization_payment_methods"]["Update"];

export type CompanyPaymentGatewayRow =
  Database["public"]["Tables"]["organization_payment_gateways"]["Row"];
export type CompanyPaymentGatewayInsert =
  Database["public"]["Tables"]["organization_payment_gateways"]["Insert"];
export type CompanyPaymentGatewayUpdate =
  Database["public"]["Tables"]["organization_payment_gateways"]["Update"];

/**
 * The DB table name. Centralised so a future rename migration only
 * has to update this constant.
 */
export const COMPANY_PAYMENT_METHODS_TABLE = "organization_payment_methods" as const;
export const COMPANY_PAYMENT_GATEWAYS_TABLE = "organization_payment_gateways" as const;