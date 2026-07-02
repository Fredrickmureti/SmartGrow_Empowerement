/**
 * Centralized legal-entity branding loader for edge functions.
 *
 * Per the multi-entity ERP redesign (Odoo model): document branding lives
 * on `businesses` (the legal/accounting entity), NEVER on `organizations`
 * (the tenant). This loader resolves a business and returns its identity.
 *
 * Resolution rules:
 *   1. If `businessId` is provided, load that business directly.
 *   2. If `branchId` is provided, apply get_effective_company_config overrides.
 *   3. Else, load the org's primary (oldest active) business.
 *
 * The function name and return shape are preserved so existing PDF/email
 * pipelines (generate-report-pdf, generate-document, generate-payslip-pdf,
 * generate-payroll-document, generate-audit-certificate, send-document-email)
 * keep working without code changes — they now automatically read the
 * correct legal-entity identity.
 */

export interface OrganizationBranding {
  /** Business id (renamed semantically; legacy callers used to receive org id) */
  id?: string;
  /** Legal/business name shown on documents */
  name: string;
  logo_url: string | null;
  email: string | null;
  phone: string | null;
  address: string | null;
  city: string | null;
  state: string | null;
  postal_code: string | null;
  country: string | null;
  tax_id: string | null;
  /** Business's accounting currency */
  base_currency?: string | null;
  /** Optional: legal name distinct from trading name */
  legal_name?: string | null;
  /** Optional: business registration number */
  registration_number?: string | null;
  /** Tenant-configured display name override for outbound email From-line */
  email_display_name?: string | null;
  /** Tenant-configured Reply-To override for outbound email */
  email_reply_to?: string | null;
}

const BUSINESS_SELECT_COLUMNS =
  "id, name, legal_name, registration_number, logo_url, email, phone, address, city, state, postal_code, country, tax_id, base_currency, email_display_name, email_reply_to";

/**
 * Fetch and normalize legal-entity branding for an organization.
 *
 * @param supabase - server-side Supabase client (service-role recommended)
 * @param organizationId - tenant org id (used to find the primary business when businessId is omitted)
 * @param businessId - optional explicit business id (preferred when the calling pipeline knows the source record's business_id)
 * @returns canonical OrganizationBranding, or null if no business found
 */
export async function getOrganizationBranding(
  // deno-lint-ignore no-explicit-any
  supabase: any,
  organizationId: string,
  businessId?: string | null,
  branchId?: string | null,
): Promise<OrganizationBranding | null> {
  if (!organizationId && !businessId) return null;

  // Path A: explicit business id
  if (businessId) {
    const { data, error } = await supabase
      .from("businesses")
      .select(BUSINESS_SELECT_COLUMNS)
      .eq("id", businessId)
      .maybeSingle();
    if (error) {
      console.warn("[branding] failed to load business", businessId, error.message);
      return null;
    }
    if (data) return applyEffectiveOverrides(supabase, normalize(data), businessId, branchId);
  }

  // Path B: org's primary (oldest active) business
  const { data, error } = await supabase
    .from("businesses")
    .select(BUSINESS_SELECT_COLUMNS)
    .eq("organization_id", organizationId)
    .eq("is_active", true)
    .order("created_at", { ascending: true })
    .limit(1)
    .maybeSingle();

  if (error) {
    console.warn("[branding] failed to load primary business for org", organizationId, error.message);
    return null;
  }
  if (!data) return null;
  return applyEffectiveOverrides(supabase, normalize(data), data.id, branchId);
}

// deno-lint-ignore no-explicit-any
function normalize(data: any): OrganizationBranding {
  return {
    id: data.id,
    name: data.legal_name ?? data.name ?? "",
    legal_name: data.legal_name ?? null,
    registration_number: data.registration_number ?? null,
    logo_url: data.logo_url ?? null,
    email: data.email ?? null,
    phone: data.phone ?? null,
    address: data.address ?? null,
    city: data.city ?? null,
    state: data.state ?? null,
    postal_code: data.postal_code ?? null,
    country: data.country ?? null,
    tax_id: data.tax_id ?? null,
    base_currency: data.base_currency ?? null,
    email_display_name: data.email_display_name ?? null,
    email_reply_to: data.email_reply_to ?? null,
  };
}

async function applyEffectiveOverrides(
  supabase: any,
  branding: OrganizationBranding,
  businessId?: string | null,
  branchId?: string | null,
): Promise<OrganizationBranding> {
  if (!businessId || !branchId) return branding;
  const { data, error } = await supabase.rpc("get_effective_company_config", {
    p_business_id: businessId,
    p_branch_id: branchId,
  });
  if (error || !data) {
    if (error) console.warn("[branding] effective config failed", error.message);
    return branding;
  }
  return {
    ...branding,
    logo_url: data.logo_url?.value ?? branding.logo_url,
    tax_id: data.tax_id?.value ?? branding.tax_id,
    base_currency: data.base_currency?.value ?? branding.base_currency,
  };
}

// ── Logo byte cache ────────────────────────────────────────────────────
//
// Keyed by logo URL. A single edge-function invocation that renders many
// pages reuses the same Uint8Array. Cache lives for the lifetime of the
// isolate (TTL not enforced here — the Worker recycles regularly).

const logoCache = new Map<string, Uint8Array | null>();

export async function fetchLogoBytes(logoUrl: string | null | undefined): Promise<Uint8Array | null> {
  if (!logoUrl) return null;
  if (logoCache.has(logoUrl)) return logoCache.get(logoUrl) ?? null;

  try {
    const response = await fetch(logoUrl);
    if (!response.ok) {
      logoCache.set(logoUrl, null);
      return null;
    }
    const buffer = new Uint8Array(await response.arrayBuffer());
    logoCache.set(logoUrl, buffer);
    return buffer;
  } catch (e) {
    console.warn("[branding] failed to fetch logo", logoUrl, (e as Error).message);
    logoCache.set(logoUrl, null);
    return null;
  }
}
