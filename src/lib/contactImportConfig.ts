import { FieldDefinition } from "@/lib/importUtils";
import { resolveContactType } from "@/lib/contactTypeResolver";
import { CustomerGroupResolver } from "@/lib/customerGroupResolver";
import { supabase } from "@/integrations/supabase/client";
import { typeFromRoles } from "@/lib/contactRoles";

/**
 * Canonical contact field definitions for CSV/XLSX import.
 * Used by BOTH the Contacts page import AND the Migration step.
 *
 * Phase 6 round-trip support:
 *   - is_company           — flags companies (no parent linkage)
 *   - parent_company_name  — links individuals/sub-contacts to their parent
 *                            company by name (case-insensitive, auto-created)
 *   - child_address_type   — Odoo-style sub-contact role (contact|invoice|
 *                            delivery|other)
 *   - is_customer / is_supplier — role flags. The legacy `type` enum stays
 *                            as a back-compat alias and is recomputed via
 *                            typeFromRoles when role flags are present.
 *
 * DO NOT duplicate this. If you need contact import anywhere,
 * import from this file.
 */
export const CONTACT_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "name", label: "Name", required: true, type: "text", aliases: ["full name", "contact name", "customer", "supplier", "vendor", "contact", "company"] },
  { key: "email", label: "Email", required: false, type: "email", aliases: ["e-mail", "email address", "email_address"] },
  { key: "phone", label: "Phone", required: false, type: "text", aliases: ["phone number", "phone_number", "tel", "mobile", "telephone"] },
  { key: "is_company", label: "Is Company", required: false, type: "text", aliases: ["company?", "company_flag", "is company", "iscompany"], helpText: "yes/no — flags this row as a company (no parent)." },
  { key: "parent_company_name", label: "Parent Company", required: false, type: "text", aliases: ["company name", "company_name", "organization", "org", "parent company", "parent_company", "works at", "works_at", "employer"], helpText: "Name of the parent company. Auto-created if missing." },
  { key: "child_address_type", label: "Address Role", required: false, type: "select", aliases: ["address role", "role at company", "address_type", "child address type"], options: ["contact", "invoice", "delivery", "other"], allowFallback: true, fallbackValue: "contact" },
  { key: "is_customer", label: "Is Customer", required: false, type: "text", aliases: ["customer?", "is_customer", "iscustomer"], helpText: "yes/no" },
  { key: "is_supplier", label: "Is Supplier", required: false, type: "text", aliases: ["supplier?", "is_supplier", "issupplier", "vendor?"], helpText: "yes/no" },
  { key: "type", label: "Type", required: false, type: "select", aliases: ["contact type", "contact_type", "category", "classification"], options: ["customer", "supplier", "both"], allowFallback: true, fallbackValue: "customer" },
  { key: "customer_group", label: "Customer Group", required: false, type: "text", aliases: ["group", "customer category", "customer_group"] },
  { key: "address_line1", label: "Address", required: false, type: "text", aliases: ["street", "address line 1", "address", "street address", "address_line_1", "billing address", "billing_address"] },
  { key: "city", label: "City", required: false, type: "text", aliases: ["town", "locality"] },
  { key: "state", label: "State", required: false, type: "text", aliases: ["province", "region", "county"] },
  { key: "postal_code", label: "Postal Code", required: false, type: "text", aliases: ["zip", "zip code", "zip_code", "postcode", "post_code"] },
  { key: "country", label: "Country", required: false, type: "text", aliases: ["country_code", "nation"] },
  { key: "tax_id", label: "Tax ID", required: false, type: "text", aliases: ["tin", "tax number", "tax_number", "vat", "ein", "kra_pin"] },
  { key: "credit_limit", label: "Credit Limit", required: false, type: "number", aliases: ["credit"] },
  { key: "notes", label: "Notes", required: false, type: "text", aliases: ["comments", "remarks", "description"] },
];

// ---------- Parsing helpers (pure, exported for tests) ----------

const TRUE_TOKENS = new Set(["true", "yes", "y", "1", "x", "t"]);
const FALSE_TOKENS = new Set(["false", "no", "n", "0", "", "f"]);

/** Parse a loose CSV boolean. Returns undefined when the cell wasn't set. */
export function parseImportBool(raw: unknown): boolean | undefined {
  if (raw === undefined || raw === null) return undefined;
  if (typeof raw === "boolean") return raw;
  const v = String(raw).trim().toLowerCase();
  if (v === "") return undefined;
  if (TRUE_TOKENS.has(v)) return true;
  if (FALSE_TOKENS.has(v)) return false;
  return undefined;
}

/**
 * Derive (customer_rank, supplier_rank, type) from a row.
 * - Prefers explicit is_customer / is_supplier flags.
 * - Falls back to the legacy `type` enum (customer|supplier|both).
 * - Defaults to a plain customer when nothing was provided.
 */
export function deriveRolesFromRow(row: Record<string, any>): {
  customer_rank: number;
  supplier_rank: number;
  type: "customer" | "supplier" | "both";
} {
  const ic = parseImportBool(row.is_customer);
  const is = parseImportBool(row.is_supplier);
  let isCustomer: boolean;
  let isSupplier: boolean;
  if (ic !== undefined || is !== undefined) {
    isCustomer = ic ?? false;
    isSupplier = is ?? false;
    if (!isCustomer && !isSupplier) isCustomer = true; // never write a roleless contact
  } else {
    const resolved = resolveContactType(row.type || "customer").value;
    isCustomer = resolved === "customer" || resolved === "both";
    isSupplier = resolved === "supplier" || resolved === "both";
  }
  return {
    customer_rank: isCustomer ? 1 : 0,
    supplier_rank: isSupplier ? 1 : 0,
    type: typeFromRoles({ isCustomer, isSupplier }),
  };
}

function normalizeName(s: unknown): string {
  return String(s ?? "").trim();
}

function lower(s: string): string {
  return s.toLowerCase();
}

// ---------- Parent-company resolver (two-pass) ----------

/**
 * Resolves and lazily creates parent companies for a (org, business) scope.
 * Used by both the single-row and batch import handlers so behaviour stays
 * identical between the migration wizard and the Contacts page importer.
 */
class ParentCompanyResolver {
  private cache = new Map<string, string>(); // lowerName -> contactId
  private prefetched = false;

  constructor(
    private readonly orgId: string,
    private readonly businessId: string,
  ) {}

  async prefetch(names: string[]): Promise<void> {
    if (this.prefetched || names.length === 0) return;
    this.prefetched = true;
    const unique = Array.from(new Set(names.map(normalizeName).filter(Boolean)));
    if (unique.length === 0) return;
    const { data } = await supabase
      .from("contacts")
      .select("id, name")
      .eq("organization_id", this.orgId)
      .eq("business_id", this.businessId)
      .eq("is_company", true)
      .in("name", unique);
    for (const row of data || []) {
      this.cache.set(lower(String(row.name)), String(row.id));
    }
  }

  async resolve(rawName: unknown): Promise<string | null> {
    const name = normalizeName(rawName);
    if (!name) return null;
    const key = lower(name);
    const cached = this.cache.get(key);
    if (cached) return cached;

    // Last-chance lookup for callers that skipped prefetch.
    const { data: existing } = await supabase
      .from("contacts")
      .select("id")
      .eq("organization_id", this.orgId)
      .eq("business_id", this.businessId)
      .eq("is_company", true)
      .ilike("name", name)
      .limit(1);
    if (existing && existing.length > 0) {
      this.cache.set(key, String(existing[0].id));
      return String(existing[0].id);
    }

    const { data: created, error } = await supabase
      .from("contacts")
      .insert({
        organization_id: this.orgId,
        business_id: this.businessId,
        name,
        is_company: true,
        customer_rank: 0,
        supplier_rank: 0,
        type: "customer", // legacy default — not user-visible on companies
        is_active: true,
      })
      .select("id")
      .single();
    if (error || !created) return null;
    this.cache.set(key, String(created.id));
    return String(created.id);
  }
}

// ---------- Public handlers ----------

/**
 * Single-row contact import handler. Used by the migration wizard and
 * any caller that needs per-row error reporting.
 */
export function createContactImportHandler(
  orgId: string,
  businessId: string,
  createFn: (data: Record<string, any>) => Promise<void>,
  options?: { dedup?: boolean }
) {
  let customerGroupResolver: CustomerGroupResolver | null = null;
  const parentResolver = new ParentCompanyResolver(orgId, businessId);

  return async (row: Record<string, any>) => {
    if (options?.dedup) {
      const { data: existing } = await supabase
        .from("contacts")
        .select("id")
        .eq("organization_id", orgId)
        .eq("business_id", businessId)
        .ilike("name", String(row.name).trim())
        .limit(1);

      if (existing && existing.length > 0) return;
    }

    const isCompany = parseImportBool(row.is_company) ?? false;
    const roles = deriveRolesFromRow(row);

    let parentId: string | null = null;
    let childAddressType: string | null = null;
    if (!isCompany) {
      parentId = await parentResolver.resolve(row.parent_company_name);
      if (parentId && row.child_address_type) {
        childAddressType = String(row.child_address_type).trim().toLowerCase();
      }
    }

    let customerGroupValue: string | null = null;
    if (row.customer_group) {
      if (!customerGroupResolver) {
        customerGroupResolver = new CustomerGroupResolver(orgId, businessId);
      }
      customerGroupValue = await customerGroupResolver.resolve(row.customer_group);
    }

    await createFn({
      name: normalizeName(row.name),
      email: row.email || null,
      phone: row.phone || null,
      is_company: isCompany,
      parent_contact_id: parentId,
      ...(childAddressType ? { child_address_type: childAddressType } : {}),
      type: roles.type,
      customer_rank: roles.customer_rank,
      supplier_rank: roles.supplier_rank,
      customer_group_id: customerGroupValue,
      address_line1: row.address_line1 || null,
      city: row.city || null,
      state: row.state || null,
      postal_code: row.postal_code || null,
      country: row.country || null,
      tax_id: row.tax_id || null,
      credit_limit: row.credit_limit ? Number(row.credit_limit) : null,
      notes: row.notes || null,
      is_active: true,
    });
  };
}

/**
 * Batch contact import handler for migration.
 *
 * Two-pass strategy:
 *   1. Resolve / create every parent company referenced by the batch.
 *   2. Insert individuals + companies with their parent_contact_id wired.
 *
 * Chunked at 200 rows with row-by-row fallback for error isolation.
 */
export function createContactBatchImportHandler(
  orgId: string,
  businessId: string,
  _createFn?: (data: Record<string, any>) => Promise<void>,
) {
  return async (rows: Record<string, any>[]) => {
    const errors: { rowIndex: number; data: Record<string, any>; errors: string }[] = [];

    // Pre-fetch existing contact names for dedup.
    const { data: existing } = await supabase
      .from("contacts")
      .select("name")
      .eq("organization_id", orgId)
      .eq("business_id", businessId)
      .eq("is_active", true);

    const existingNames = new Set(
      (existing || []).map((c: any) => normalizeName(c.name).toLowerCase()),
    );

    // ---- Pass 1: parent companies ----
    const parentResolver = new ParentCompanyResolver(orgId, businessId);
    const referencedParents = new Set<string>();
    for (const row of rows) {
      const isCompany = parseImportBool(row.is_company) ?? false;
      if (isCompany) continue;
      const pn = normalizeName(row.parent_company_name);
      if (pn) referencedParents.add(pn);
    }
    await parentResolver.prefetch(Array.from(referencedParents));
    for (const name of referencedParents) {
      // ensure (creates if missing); rank=0 stubs are fine for company shells.
      await parentResolver.resolve(name);
      existingNames.add(name.toLowerCase());
    }

    // ---- Pass 2: prepare row inserts ----
    const customerGroupResolver = new CustomerGroupResolver(orgId, businessId);
    const insertRows: any[] = [];
    const rowIndexMap: number[] = [];

    for (let i = 0; i < rows.length; i++) {
      const row = rows[i];
      const name = normalizeName(row.name);
      if (!name) {
        errors.push({ rowIndex: i + 2, data: row, errors: "Name is required" });
        continue;
      }
      if (existingNames.has(name.toLowerCase())) continue;
      existingNames.add(name.toLowerCase());

      const isCompany = parseImportBool(row.is_company) ?? false;
      const roles = deriveRolesFromRow(row);

      let parentId: string | null = null;
      let childAddressType: string | null = null;
      if (!isCompany) {
        parentId = await parentResolver.resolve(row.parent_company_name);
        if (parentId && row.child_address_type) {
          childAddressType = String(row.child_address_type).trim().toLowerCase();
        }
      }

      let customerGroupValue: string | null = null;
      if (row.customer_group) {
        customerGroupValue = await customerGroupResolver.resolve(row.customer_group);
      }

      insertRows.push({
        organization_id: orgId,
        business_id: businessId,
        name,
        email: row.email || null,
        phone: row.phone || null,
        is_company: isCompany,
        parent_contact_id: parentId,
        ...(childAddressType ? { child_address_type: childAddressType } : {}),
        type: roles.type,
        customer_rank: roles.customer_rank,
        supplier_rank: roles.supplier_rank,
        customer_group_id: customerGroupValue,
        address_line1: row.address_line1 || null,
        city: row.city || null,
        state: row.state || null,
        postal_code: row.postal_code || null,
        country: row.country || null,
        tax_id: row.tax_id || null,
        credit_limit: row.credit_limit ? Number(row.credit_limit) : null,
        notes: row.notes || null,
        is_active: true,
      });
      rowIndexMap.push(i);
    }

    const CHUNK = 200;
    let imported = 0;
    for (let i = 0; i < insertRows.length; i += CHUNK) {
      const chunk = insertRows.slice(i, i + CHUNK);
      const { error } = await supabase.from("contacts").insert(chunk);
      if (error) {
        for (let j = 0; j < chunk.length; j++) {
          const { error: rowErr } = await supabase.from("contacts").insert(chunk[j]);
          if (rowErr) {
            errors.push({ rowIndex: rowIndexMap[i + j] + 2, data: rows[rowIndexMap[i + j]], errors: rowErr.message });
          } else {
            imported++;
          }
        }
      } else {
        imported += chunk.length;
      }
    }

    return { total: rows.length, imported, skipped: rows.length - imported - errors.length, errors };
  };
}
