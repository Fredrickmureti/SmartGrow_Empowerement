/**
 * Shared column mapping for migration stages.
 * Replaces duplicated inline regex column detection across TB, AR, AP, Inventory.
 * 
 * Uses FieldDefinition-style specs with aliases, integrated with 
 * source system presets for smarter detection.
 */

import { detectSourceSystem, mapColumnsForSystem } from "./sourceSystemPresets";

export interface MigrationFieldSpec {
  /** Internal field key */
  key: string;
  /** Display label */
  label: string;
  /** Whether the field is required */
  required: boolean;
  /** Regex patterns to match CSV headers (fallback after source system detection) */
  patterns: RegExp[];
  /** Type hint for parsing */
  type: "string" | "number" | "date";
  /** Source system preset field name (used by mapColumnsForSystem) */
  sourceField?: string;
}

export interface ColumnMapping {
  /** Maps internal field key → CSV header name */
  fieldToHeader: Record<string, string>;
  /** Detected source system (if any) */
  detectedSystem: string | null;
  /** Fields that could not be mapped */
  unmappedFields: string[];
  /** CSV headers that were not mapped to any field */
  unmappedHeaders: string[];
}

/**
 * Auto-map CSV headers to migration field specs.
 * Priority: source system preset > regex pattern match > positional fallback.
 */
export function autoMapMigrationColumns(
  headers: string[],
  fields: MigrationFieldSpec[],
  stepKey: string
): ColumnMapping {
  const detectedSystem = detectSourceSystem(headers);
  const systemMapping = detectedSystem
    ? mapColumnsForSystem(detectedSystem, stepKey, headers)
    : {};

  // Reverse map: targetField → header
  const reverseMap: Record<string, string> = {};
  for (const [header, targetField] of Object.entries(systemMapping)) {
    reverseMap[targetField] = header;
  }

  const fieldToHeader: Record<string, string> = {};
  const usedHeaders = new Set<string>();

  for (const field of fields) {
    // 1. Try source system preset match
    if (field.sourceField && reverseMap[field.sourceField]) {
      fieldToHeader[field.key] = reverseMap[field.sourceField];
      usedHeaders.add(reverseMap[field.sourceField]);
      continue;
    }

    // 2. Try regex pattern match
    const matched = headers.find(
      (h) => !usedHeaders.has(h) && field.patterns.some((p) => p.test(h))
    );
    if (matched) {
      fieldToHeader[field.key] = matched;
      usedHeaders.add(matched);
      continue;
    }
  }

  const unmappedFields = fields
    .filter((f) => !fieldToHeader[f.key])
    .map((f) => f.key);
  const unmappedHeaders = headers.filter((h) => !usedHeaders.has(h));

  return { fieldToHeader, detectedSystem, unmappedFields, unmappedHeaders };
}

/**
 * Extract a typed value from a row using the column mapping.
 */
export function getMappedValue(
  row: Record<string, string>,
  fieldKey: string,
  mapping: ColumnMapping,
  fields: MigrationFieldSpec[]
): string | number | null {
  const header = mapping.fieldToHeader[fieldKey];
  if (!header) return null;

  const raw = (row[header] || "").trim();
  if (!raw) return null;

  const field = fields.find((f) => f.key === fieldKey);
  if (field?.type === "number") {
    const num = parseFloat(raw.replace(/[^0-9.\-]/g, ""));
    return isNaN(num) ? null : num;
  }

  return raw;
}

/**
 * Validate a mapped row before import.
 * Returns array of error messages (empty = valid).
 */
export function validateMappedRow(
  row: Record<string, string>,
  mapping: ColumnMapping,
  fields: MigrationFieldSpec[]
): string[] {
  const errors: string[] = [];

  for (const field of fields) {
    const value = getMappedValue(row, field.key, mapping, fields);

    if (field.required && (value === null || value === "")) {
      errors.push(`${field.label} is required`);
      continue;
    }

    if (value === null || value === "") continue;

    if (field.type === "number" && typeof value === "string") {
      errors.push(`${field.label} must be a number`);
    }

    if (field.type === "date" && typeof value === "string") {
      const d = new Date(value);
      if (isNaN(d.getTime())) {
        errors.push(`${field.label} has invalid date format`);
      }
    }
  }

  return errors;
}

// ──────────────────────────────────────────────────
// Field spec definitions per migration stage
// ──────────────────────────────────────────────────

export const TRIAL_BALANCE_FIELDS: MigrationFieldSpec[] = [
  {
    key: "account_code",
    label: "Account Code",
    required: true,
    patterns: [/code|account.?code|acct/i],
    type: "string",
    sourceField: "account_code",
  },
  {
    key: "account_name",
    label: "Account Name",
    required: false,
    patterns: [/name|account.?name|description/i],
    type: "string",
    sourceField: "account_name",
  },
  {
    key: "debit",
    label: "Debit",
    required: false,
    patterns: [/debit/i],
    type: "number",
    sourceField: "debit",
  },
  {
    key: "credit",
    label: "Credit",
    required: false,
    patterns: [/credit/i],
    type: "number",
    sourceField: "credit",
  },
  {
    key: "balance",
    label: "Balance",
    required: false,
    patterns: [/balance|amount|opening/i],
    type: "number",
    sourceField: "balance",
  },
];

export const OPEN_AR_FIELDS: MigrationFieldSpec[] = [
  {
    key: "entity_name",
    label: "Customer Name",
    required: true,
    patterns: [/customer|client|name/i],
    type: "string",
    sourceField: "customer_name",
  },
  {
    key: "doc_number",
    label: "Invoice #",
    required: false,
    patterns: [/invoice.?num|inv.?no|number/i],
    type: "string",
    sourceField: "invoice_number",
  },
  {
    key: "doc_date",
    label: "Invoice Date",
    required: false,
    patterns: [/invoice.?date|date|issue/i],
    type: "date",
    sourceField: "invoice_date",
  },
  {
    key: "due_date",
    label: "Due Date",
    required: false,
    patterns: [/due.?date|due/i],
    type: "date",
    sourceField: "due_date",
  },
  {
    key: "amount",
    label: "Amount",
    required: true,
    patterns: [/amount|total|balance/i],
    type: "number",
    sourceField: "amount",
  },
  {
    key: "amount_paid",
    label: "Amount Paid",
    required: false,
    patterns: [/paid|amount.?paid|payment/i],
    type: "number",
  },
  {
    key: "currency",
    label: "Currency",
    required: false,
    patterns: [/currency|curr/i],
    type: "string",
  },
];

export const OPEN_AP_FIELDS: MigrationFieldSpec[] = [
  {
    key: "entity_name",
    label: "Supplier Name",
    required: true,
    patterns: [/supplier|vendor|name/i],
    type: "string",
    sourceField: "supplier_name",
  },
  {
    key: "doc_number",
    label: "Bill #",
    required: false,
    patterns: [/bill.?num|bill.?no|number/i],
    type: "string",
    sourceField: "bill_number",
  },
  {
    key: "doc_date",
    label: "Bill Date",
    required: false,
    patterns: [/bill.?date|date|issue/i],
    type: "date",
    sourceField: "bill_date",
  },
  {
    key: "due_date",
    label: "Due Date",
    required: false,
    patterns: [/due.?date|due/i],
    type: "date",
    sourceField: "due_date",
  },
  {
    key: "amount",
    label: "Amount",
    required: true,
    patterns: [/amount|total|balance/i],
    type: "number",
    sourceField: "amount",
  },
  {
    key: "amount_paid",
    label: "Amount Paid",
    required: false,
    patterns: [/paid|amount.?paid|payment/i],
    type: "number",
  },
  {
    key: "currency",
    label: "Currency",
    required: false,
    patterns: [/currency|curr/i],
    type: "string",
  },
];

export const INVENTORY_FIELDS: MigrationFieldSpec[] = [
  {
    key: "product_name",
    label: "Product Name",
    required: true,
    patterns: [/product.?name|name|item/i],
    type: "string",
  },
  {
    key: "sku",
    label: "SKU",
    required: false,
    patterns: [/sku|code|item.?code/i],
    type: "string",
  },
  {
    key: "quantity",
    label: "Quantity",
    required: true,
    patterns: [/quantity|qty|stock/i],
    type: "number",
  },
  {
    key: "unit_cost",
    label: "Unit Cost",
    required: false,
    patterns: [/unit.?cost|cost|price/i],
    type: "number",
  },
  {
    key: "total_value",
    label: "Total Value",
    required: false,
    patterns: [/total.?value|value|total/i],
    type: "number",
  },
];
