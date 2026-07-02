/**
 * Dynamic employee import schema.
 *
 * Composes the importable column list at runtime from three sources, so
 * installing a localization pack (or defining custom fields in Studio) makes
 * those fields immediately importable — no engineering change required.
 *
 *   1. Core employee columns (static, defined here)
 *   2. Pack-required statutory identifiers (`public.pack_requirements`,
 *      scope = 'statutory_identifier') — landed in
 *      `employee_statutory_identifiers`
 *   3. Tenant custom fields (`public.entity_field_configs`,
 *      entity_type = 'employee') — landed in `entity_field_values`
 *
 * Imported rows are split by `splitImportedEmployeeRow()` into the three
 * destinations so the caller can persist them atomically.
 */
import type { FieldDefinition } from "@/lib/importUtils";
import { EMPLOYEE_IMPORT_FIELDS } from "@/lib/importConfigs/employeeImportConfig";

const STATUTORY_PREFIX = "statutory.";
const CUSTOM_PREFIX = "custom.";

export interface PackRequirementRow {
  requirement_key: string;
  label: string | null;
  data_type: string | null;
  is_required: boolean | null;
  is_active: boolean | null;
  validation_regex: string | null;
  help_text: string | null;
  sort_order: number | null;
  scope: string | null;
}

export interface EntityFieldConfigRow {
  field_key: string;
  field_label: string | null;
  field_type: string | null;
  is_required: boolean | null;
  is_visible: boolean | null;
  options: unknown;
  display_order: number | null;
  entity_type: string | null;
  validation_rules?: unknown;
  help_text?: string | null;
}

export interface CustomFieldExtra {
  field_config_id?: string;
}

export interface SplitEmployeeRow {
  core: Record<string, unknown>;
  statutory: Array<{ identifier_type: string; identifier_value: string }>;
  customFields: Array<{ field_key: string; field_value: string }>;
}

function dataTypeToFieldType(t: string | null | undefined): FieldDefinition["type"] {
  switch ((t || "").toLowerCase()) {
    case "number":
    case "integer":
    case "decimal":
    case "currency":
      return "number";
    case "date":
    case "datetime":
      return "date";
    case "email":
      return "email";
    case "enum":
    case "select":
      return "select";
    default:
      return "text";
  }
}

function optionList(raw: unknown): string[] | undefined {
  if (Array.isArray(raw)) return raw.map((v) => String(v));
  if (raw && typeof raw === "object" && Array.isArray((raw as any).values)) {
    return (raw as any).values.map((v: unknown) => String(v));
  }
  return undefined;
}

/**
 * Compose the field list for the importer. Core fields first, then pack
 * statutory identifiers (sorted by `sort_order`), then custom fields
 * (sorted by `display_order`).
 */
export function composeEmployeeImportFields(
  packRequirements: PackRequirementRow[],
  entityFieldConfigs: EntityFieldConfigRow[],
): FieldDefinition[] {
  const statFields: FieldDefinition[] = packRequirements
    .filter((r) => r.is_active !== false && (r.scope ?? "statutory_identifier") === "statutory_identifier")
    .sort((a, b) => (a.sort_order ?? 999) - (b.sort_order ?? 999))
    .map((r) => ({
      key: `${STATUTORY_PREFIX}${r.requirement_key}`,
      label: r.label || r.requirement_key,
      required: !!r.is_required,
      type: dataTypeToFieldType(r.data_type),
      aliases: [r.requirement_key, r.label || r.requirement_key].filter(Boolean) as string[],
      ...(r.validation_regex ? { pattern: r.validation_regex } : {}),
      ...(r.help_text ? { helpText: r.help_text } : {}),
    }));

  const customFields: FieldDefinition[] = entityFieldConfigs
    .filter((c) => (c.entity_type ?? "employee") === "employee" && c.is_visible !== false)
    .sort((a, b) => (a.display_order ?? 999) - (b.display_order ?? 999))
    .map((c) => {
      const opts = optionList(c.options);
      const rules = (c.validation_rules && typeof c.validation_rules === "object")
        ? (c.validation_rules as Record<string, unknown>)
        : null;
      const pattern = rules && typeof rules.pattern === "string" ? rules.pattern : undefined;
      return {
        key: `${CUSTOM_PREFIX}${c.field_key}`,
        label: c.field_label || c.field_key,
        required: !!c.is_required,
        type: opts ? "select" : dataTypeToFieldType(c.field_type),
        aliases: [c.field_key, c.field_label || c.field_key].filter(Boolean) as string[],
        ...(opts ? { options: opts, allowFallback: true } : {}),
        ...(pattern ? { pattern } : {}),
        ...(c.help_text ? { helpText: c.help_text } : {}),
      } as FieldDefinition;
    });

  return [...EMPLOYEE_IMPORT_FIELDS, ...statFields, ...customFields];
}

/**
 * Split an imported row into (core employee payload, statutory identifiers,
 * custom field values). Empty strings are dropped — only meaningful values
 * are forwarded to the writer.
 */
export function splitImportedEmployeeRow(row: Record<string, unknown>): SplitEmployeeRow {
  const core: Record<string, unknown> = {};
  const statutory: SplitEmployeeRow["statutory"] = [];
  const customFields: SplitEmployeeRow["customFields"] = [];

  for (const [k, v] of Object.entries(row)) {
    if (v === undefined || v === null || (typeof v === "string" && v.trim() === "")) continue;
    if (k.startsWith(STATUTORY_PREFIX)) {
      statutory.push({
        identifier_type: k.slice(STATUTORY_PREFIX.length),
        identifier_value: String(v).trim(),
      });
    } else if (k.startsWith(CUSTOM_PREFIX)) {
      customFields.push({
        field_key: k.slice(CUSTOM_PREFIX.length),
        field_value: String(v).trim(),
      });
    } else {
      core[k] = v;
    }
  }

  return { core, statutory, customFields };
}

export const __INTERNAL = { STATUTORY_PREFIX, CUSTOM_PREFIX };
