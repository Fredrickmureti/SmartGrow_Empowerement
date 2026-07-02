/**
 * Contact type synonym resolver.
 * Maps common CSV values to valid contact_type enum values.
 */

const TYPE_SYNONYMS: Record<string, "customer" | "supplier" | "both"> = {
  customer: "customer",
  client: "customer",
  buyer: "customer",
  purchaser: "customer",
  vendor: "supplier",
  supplier: "supplier",
  provider: "supplier",
  seller: "supplier",
  both: "both",
  "customer/vendor": "both",
  "vendor/customer": "both",
  "customer/supplier": "both",
  "supplier/customer": "both",
  "customer & vendor": "both",
  "customer and vendor": "both",
  "customer & supplier": "both",
  "customer and supplier": "both",
};

/**
 * Resolve a raw type string from CSV to a valid contact_type enum value.
 * Returns the resolved type and whether a fallback was used.
 */
export function resolveContactType(rawType: string): {
  value: "customer" | "supplier" | "both";
  wasFallback: boolean;
} {
  if (!rawType || !rawType.trim()) {
    return { value: "customer", wasFallback: false };
  }

  const normalized = rawType.toLowerCase().trim().replace(/[^a-z/&\s]/g, "");
  const match = TYPE_SYNONYMS[normalized];

  if (match) {
    return { value: match, wasFallback: false };
  }

  // Default to "customer" with fallback flag
  return { value: "customer", wasFallback: true };
}
