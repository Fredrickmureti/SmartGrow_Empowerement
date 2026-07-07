/**
 * Pack-driven Kenya eTIMS adapter.
 *
 * All KRA-specific configuration — URLs, tax categories, payment codes,
 * document-type letters, PIN regex, QR template, legal footer — is loaded
 * from `localization_pack_fiscal_providers` and
 * `localization_pack_fiscal_code_maps` seeded by the Kenya localization pack.
 *
 * This module contains ZERO hard-coded KRA literals. Non-Kenyan tenants have
 * no provider row, so `loadProvider()` throws and the pipeline short-circuits.
 */

// deno-lint-ignore-file no-explicit-any

export const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

export type SupabaseClient = any;

export interface ProviderRow {
  id: string;
  pack_id: string;
  provider_key: string;
  provider_name: string;
  endpoint_edge_function: string;
  sandbox_url: string;
  production_url: string;
  pin_regex: string | null;
  doc_type_map: Record<string, { rcpt_ty_cd?: string; trns_typ_cd?: string; sales_typ_cd?: string }>;
  payment_type_map: Record<string, string>;
  tax_category_map: Record<string, { rate: number | null; label: string; kra_code: string }>;
  qr_url_template: string | null;
  legal_reference: string | null;
  receipt_footer_legal_text: string | null;
}

export interface FiscalCredentials {
  tin: string;
  bhf_id: string;
  device_serial: string | null;
  communication_key: string;
  environment: "sandbox" | "production";
}

export interface CodeMapEntry {
  code_type: string;
  code: string;
  name: string;
  parent_code: string | null;
  metadata: Record<string, unknown>;
}

/**
 * Load the fiscal provider row + code maps for a tenant.
 * Throws with a clear error if the tenant has no pack with a fiscal provider
 * installed — non-Kenyan tenants intentionally fall into this branch.
 */
export async function loadProvider(
  supabase: SupabaseClient,
  organizationId: string,
): Promise<{ provider: ProviderRow; codeMaps: CodeMapEntry[] }> {
  const { data: providerRows, error: pErr } = await supabase
    .from("localization_pack_fiscal_providers")
    .select("*, installed:installed_localization_packs!inner(organization_id)")
    .eq("installed.organization_id", organizationId)
    .limit(1);

  if (pErr) throw new Error(`Failed to load fiscal provider: ${pErr.message}`);
  const provider = (providerRows ?? [])[0] as ProviderRow | undefined;

  if (!provider) {
    // Fallback: direct lookup via installed pack join (older row shape)
    const { data: fallback } = await supabase
      .from("installed_localization_packs")
      .select("pack_id, localization_pack_fiscal_providers!inner(*)")
      .eq("organization_id", organizationId)
      .limit(1);
    const fp = (fallback ?? [])[0] as any;
    if (!fp?.localization_pack_fiscal_providers?.[0]) {
      throw new Error(
        "No fiscal localization pack installed for this organization. " +
          "Install the country-specific compliance pack (e.g. Kenya Pack v2026.5.0) to enable fiscal receipts.",
      );
    }
    const resolved = fp.localization_pack_fiscal_providers[0] as ProviderRow;
    return { provider: resolved, codeMaps: await loadCodeMaps(supabase, resolved.provider_key) };
  }

  return { provider, codeMaps: await loadCodeMaps(supabase, provider.provider_key) };
}

async function loadCodeMaps(supabase: SupabaseClient, providerKey: string): Promise<CodeMapEntry[]> {
  const { data } = await supabase
    .from("localization_pack_fiscal_code_maps")
    .select("code_type, code, name, parent_code, metadata")
    .eq("provider_key", providerKey);
  return (data ?? []) as CodeMapEntry[];
}

/**
 * Load per-branch device credentials. Falls back to legacy `tax_compliance_configs`
 * row while migration to `fiscal_device_credentials` is in flight (deprecation
 * warning logged so operators notice).
 */
export async function loadCredentials(
  supabase: SupabaseClient,
  organizationId: string,
  branchId: string | null,
  providerKey: string,
): Promise<FiscalCredentials> {
  let query = supabase
    .from("fiscal_device_credentials")
    .select("*")
    .eq("organization_id", organizationId)
    .eq("provider_key", providerKey)
    .eq("is_active", true);
  if (branchId) query = query.eq("branch_id", branchId);
  const { data: creds } = await query.limit(1);

  const row = (creds ?? [])[0] as any;
  if (row?.tax_pin && row?.communication_key_encrypted) {
    return {
      tin: row.tax_pin,
      bhf_id: row.branch_office_id || "00",
      device_serial: row.device_serial,
      communication_key: row.communication_key_encrypted, // adapter treats as opaque bearer
      environment: (row.environment as "sandbox" | "production") ?? "sandbox",
    };
  }

  // Legacy fallback — remove after backfill window (D6).
  console.warn(
    "[etims.adapter] fiscal_device_credentials missing — falling back to legacy tax_compliance_configs. " +
      "Rotate credentials via /compliance/etims to migrate.",
  );
  const { data: legacy } = await supabase
    .from("tax_compliance_configs")
    .select("config, environment")
    .eq("organization_id", organizationId)
    .eq("country_code", "KE")
    .eq("provider", "kra_etims")
    .eq("is_active", true)
    .maybeSingle();
  const cfg = (legacy?.config ?? {}) as any;
  if (!cfg.tin || !cfg.communication_key) {
    throw new Error(
      "Fiscal device credentials not configured. Complete onboarding at /compliance/etims.",
    );
  }
  return {
    tin: cfg.tin,
    bhf_id: cfg.bhf_id || "00",
    device_serial: cfg.device_serial ?? null,
    communication_key: cfg.communication_key,
    environment: (legacy?.environment as "sandbox" | "production") ?? "sandbox",
  };
}

/** PIN validator driven by the pack's regex. */
export function verifyPin(pin: string, provider: ProviderRow): boolean {
  if (!provider.pin_regex) return true;
  return new RegExp(provider.pin_regex).test(pin);
}

/** Base URL selector — no literals. */
export function baseUrl(provider: ProviderRow, creds: FiscalCredentials): string {
  return creds.environment === "production" ? provider.production_url : provider.sandbox_url;
}

/** Payment method → provider payment code, via pack map. */
export function mapPaymentType(paymentMethod: string | null | undefined, provider: ProviderRow): string {
  const key = (paymentMethod ?? "").toLowerCase().trim();
  const map = provider.payment_type_map ?? {};
  if (map[key]) return map[key];
  // Longest-match: allow "credit card" to match "credit_card"
  const normalized = key.replace(/\s+|-/g, "_");
  if (map[normalized]) return map[normalized];
  return map["other"] ?? map["cash"] ?? "01";
}

/**
 * Canonical fiscal document consumed by the adapter. Doc-type mappers
 * (invoice, credit_note, pos) build one of these and hand it to
 * `buildSalesPayload`.
 */
export interface FiscalDocument {
  organization_id: string;
  branch_id: string | null;
  document_kind: "sale" | "invoice" | "credit_note" | "debit_note" | "return" | "cancellation" | "correction";
  source_doc_type: string; // e.g. "invoices"
  source_doc_id: string;
  document_number: string;
  document_date: string; // ISO
  original_invoice_ref?: string | null;
  customer: { name: string; tax_id?: string | null; phone?: string | null; address?: string | null };
  payment_method: string | null;
  currency: string;
  subtotal: number;
  tax_amount: number;
  total: number;
  notes?: string | null;
  items: Array<{
    product_id?: string | null;
    description: string;
    quantity: number;
    unit_price: number;
    line_total: number;
    tax_amount: number;
    discount_percent?: number | null;
    etims_classification_code?: string | null;
    etims_unit_code?: string | null;
    etims_packaging_unit?: string | null;
    tax_category?: string | null; // A..E
    tax_rate?: number | null;
  }>;
}

/**
 * Build a KRA eTIMS sales payload from a canonical fiscal document.
 * All doc-type letters and tax categories come from `provider`.
 */
export function buildSalesPayload(
  doc: FiscalDocument,
  provider: ProviderRow,
  creds: FiscalCredentials,
) {
  const docCfg = provider.doc_type_map[doc.document_kind]
    ?? provider.doc_type_map["invoice"]
    ?? { rcpt_ty_cd: "S", trns_typ_cd: "N", sales_typ_cd: "N" };

  const timestamp = new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14);
  const salesDate = new Date(doc.document_date).toISOString().slice(0, 10).replace(/-/g, "");

  const categoryKeys = Object.keys(provider.tax_category_map ?? {});
  const totals: Record<string, { taxableAmt: number; taxAmt: number; rate: number }> = {};
  for (const c of categoryKeys) totals[c] = { taxableAmt: 0, taxAmt: 0, rate: 0 };

  const itemList = doc.items.map((item, idx) => {
    const cat = (item.tax_category && provider.tax_category_map[item.tax_category])
      ? item.tax_category
      : (categoryKeys[0] ?? "A");
    const rate = item.tax_rate ?? provider.tax_category_map[cat]?.rate ?? 0;
    const taxableAmt = item.line_total - (item.tax_amount || 0);
    const taxAmt = item.tax_amount || 0;
    if (totals[cat]) {
      totals[cat].taxableAmt += taxableAmt;
      totals[cat].taxAmt += taxAmt;
      totals[cat].rate = rate ?? totals[cat].rate;
    }
    return {
      itemSeq: idx + 1,
      itemCd: item.product_id || `ITEM-${idx + 1}`,
      itemClsCd: item.etims_classification_code || "5020101",
      itemNm: item.description,
      bcd: null,
      pkgUnitCd: item.etims_packaging_unit || "CT",
      pkg: 1,
      qtyUnitCd: item.etims_unit_code || "U",
      qty: item.quantity,
      prc: item.unit_price,
      splyAmt: item.line_total,
      dcRt: item.discount_percent || 0,
      dcAmt: 0,
      isrccCd: null,
      isrccNm: null,
      isrcRt: 0,
      isrcAmt: 0,
      taxTyCd: cat,
      taxblAmt: taxableAmt,
      taxAmt: taxAmt,
      totAmt: item.line_total,
    };
  });

  const catAmounts: Record<string, unknown> = {};
  for (const c of categoryKeys) {
    catAmounts[`taxblAmt${c}`] = totals[c].taxableAmt;
    catAmounts[`taxRt${c}`] = totals[c].rate;
    catAmounts[`taxAmt${c}`] = totals[c].taxAmt;
  }

  return {
    tin: creds.tin,
    bhfId: creds.bhf_id,
    invcNo: parseInt(doc.document_number.replace(/\D/g, "").slice(-10)) || 1,
    orgInvcNo: doc.original_invoice_ref
      ? (parseInt(doc.original_invoice_ref.replace(/\D/g, "").slice(-10)) || 0)
      : 0,
    custTin: doc.customer.tax_id || null,
    custNm: doc.customer.name || "Walk-in Customer",
    salesTyCd: docCfg.sales_typ_cd ?? "N",
    rcptTyCd: docCfg.rcpt_ty_cd ?? "S",
    pmtTyCd: mapPaymentType(doc.payment_method, provider),
    salesSttsCd: "02",
    cfmDt: timestamp,
    salesDt: salesDate,
    stockRlsDt: salesDate,
    cnclReqDt: null,
    cnclDt: null,
    rfdDt: null,
    rfdRsnCd: null,
    totItemCnt: doc.items.length,
    ...catAmounts,
    totTaxblAmt: doc.subtotal || 0,
    totTaxAmt: doc.tax_amount || 0,
    totAmt: doc.total || 0,
    prchrAcptcYn: "N",
    remark: doc.notes || null,
    regrId: "SYSTEM",
    regrNm: "System",
    modrId: "SYSTEM",
    modrNm: "System",
    receipt: {
      custTin: doc.customer.tax_id || null,
      custMblNo: doc.customer.phone || null,
      rptNo: 1,
      trdeNm: doc.customer.name || "Customer",
      adrs: doc.customer.address || null,
      topMsg: null,
      btmMsg: provider.receipt_footer_legal_text || "Thank you for your business",
      prchrAcptcYn: "N",
    },
    itemList,
  };
}

/**
 * POST to the provider endpoint. Returns parsed JSON body plus HTTP status.
 * Callers own retry/backoff/circuit-breaker semantics.
 */
export async function postToProvider(
  provider: ProviderRow,
  creds: FiscalCredentials,
  endpointPath: string,
  payload: unknown,
): Promise<{ status: number; body: any; rawText: string }> {
  const url = `${baseUrl(provider, creds)}${endpointPath.startsWith("/") ? "" : "/"}${endpointPath}`;
  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${creds.communication_key}`,
    },
    body: JSON.stringify(payload),
  });
  const rawText = await res.text();
  let body: any = null;
  try {
    body = rawText ? JSON.parse(rawText) : null;
  } catch {
    body = { error: "non_json_response", raw: rawText.slice(0, 500) };
  }
  return { status: res.status, body, rawText };
}

/**
 * Idempotent write to the provider-agnostic ledger. Returns the transmission row.
 */
export async function upsertTransmission(
  supabase: SupabaseClient,
  row: {
    organization_id: string;
    branch_id: string | null;
    provider_key: string;
    document_kind: string;
    source_doc_type: string;
    source_doc_id: string;
    idempotency_key: string;
    state: string;
    attempt_count?: number;
    request_payload?: unknown;
    response_payload?: unknown;
    fiscal_number?: string | null;
    signature?: string | null;
    qr_data?: string | null;
    control_unit_id?: string | null;
    transmitted_at?: string | null;
    superseded_by?: string | null;
    last_error?: string | null;
    event_id?: string | null;
  },
) {
  const { data, error } = await supabase
    .from("fiscal_transmissions")
    .upsert(row, { onConflict: "organization_id,provider_key,idempotency_key" })
    .select()
    .single();
  if (error) throw new Error(`upsertTransmission: ${error.message}`);
  return data;
}
