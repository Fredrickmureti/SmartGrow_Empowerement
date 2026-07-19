import * as XLSX from "xlsx";

export interface FieldDefinition {
  key: string;
  label: string;
  required: boolean;
  type: "text" | "email" | "number" | "date" | "select" | "category";
  aliases: string[];
  options?: string[]; // for select type
  allowFallback?: boolean; // for select type: warn instead of reject on unknown values
  fallbackValue?: string; // default value when allowFallback is true
  /** Optional regex (string, JS syntax) the value must match. Sourced from pack_requirements.validation_regex. */
  pattern?: string;
  /** Optional help text shown in the import UI. Sourced from pack_requirements.help_text. */
  helpText?: string;
}

export interface ValidationError {
  field: string;
  message: string;
}

export interface ValidatedRow {
  data: Record<string, any>;
  errors: ValidationError[];
  rowIndex: number;
}

/**
 * Parse a CSV or XLSX file into an array of row objects.
 */
export async function parseFile(file: File): Promise<{ headers: string[]; rows: Record<string, string>[] }> {
  const buffer = await file.arrayBuffer();
  const workbook = XLSX.read(buffer, { type: "array", dateNF: "yyyy-mm-dd" });
  const sheetName = workbook.SheetNames[0];
  const sheet = workbook.Sheets[sheetName];

  const rawData: string[][] = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: "" });
  if (rawData.length < 2) {
    throw new Error("File must have a header row and at least one data row.");
  }

  const headers = rawData[0].map((h) => String(h).trim());
  const rows = rawData.slice(1)
    .filter((row) => row.some((cell) => String(cell).trim() !== ""))
    .map((row) => {
      const obj: Record<string, string> = {};
      headers.forEach((header, i) => {
        obj[header] = String(row[i] ?? "").trim();
      });
      return obj;
    });

  return { headers, rows };
}

/**
 * Auto-map uploaded column headers to field definitions using fuzzy matching.
 * Returns a mapping of uploadedHeader -> fieldKey (or "" for skip).
 */
export function autoMapColumns(
  headers: string[],
  fieldDefinitions: FieldDefinition[]
): Record<string, string> {
  const mapping: Record<string, string> = {};
  const usedFields = new Set<string>();

  for (const header of headers) {
    const normalizedHeader = header.toLowerCase().replace(/[^a-z0-9]/g, "");
    let bestMatch = "";

    for (const field of fieldDefinitions) {
      if (usedFields.has(field.key)) continue;

      const normalizedKey = field.key.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalizedLabel = field.label.toLowerCase().replace(/[^a-z0-9]/g, "");
      const normalizedAliases = field.aliases.map((a) =>
        a.toLowerCase().replace(/[^a-z0-9]/g, "")
      );

      if (
        normalizedHeader === normalizedKey ||
        normalizedHeader === normalizedLabel ||
        normalizedAliases.includes(normalizedHeader)
      ) {
        bestMatch = field.key;
        break;
      }
    }

    if (bestMatch) {
      mapping[header] = bestMatch;
      usedFields.add(bestMatch);
    } else {
      mapping[header] = "";
    }
  }

  return mapping;
}

/**
 * Validate a single row against field definitions.
 */
export function validateRow(
  row: Record<string, any>,
  fieldDefinitions: FieldDefinition[],
  mapping: Record<string, string>
): ValidationError[] {
  const errors: ValidationError[] = [];
  
  // Build mapped data
  const mappedData: Record<string, string> = {};
  for (const [header, fieldKey] of Object.entries(mapping)) {
    if (fieldKey) {
      mappedData[fieldKey] = row[header] || "";
    }
  }

  for (const field of fieldDefinitions) {
    const value = mappedData[field.key] || "";

    // Required check
    if (field.required && !value) {
      errors.push({ field: field.key, message: `${field.label} is required` });
      continue;
    }

    if (!value) continue;

    // Type checks
    if (field.type === "email" && value) {
      const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
      if (!emailRegex.test(value)) {
        errors.push({ field: field.key, message: `Invalid email format` });
      }
    }

    if (field.type === "number" && value) {
      if (isNaN(Number(value))) {
        errors.push({ field: field.key, message: `Must be a number` });
      }
    }

    if (field.type === "date" && value) {
      const parsed = new Date(value);
      if (isNaN(parsed.getTime())) {
        errors.push({ field: field.key, message: `Invalid date format` });
      }
    }

    if (field.type === "select" && value && field.options) {
      if (!field.options.includes(value.toLowerCase())) {
        if (field.allowFallback) {
          // Warn but don't block - the import handler will resolve this
          // No error pushed - the handler is responsible for mapping
        } else {
          errors.push({
            field: field.key,
            message: `Must be one of: ${field.options.join(", ")}`,
          });
        }
      }
    }

    // Regex pattern enforcement (pack_requirements.validation_regex).
    if (field.pattern && value) {
      try {
        const re = new RegExp(field.pattern);
        if (!re.test(String(value))) {
          errors.push({
            field: field.key,
            message: field.helpText
              ? `${field.label}: ${field.helpText}`
              : `${field.label} does not match the required format`,
          });
        }
      } catch {
        // Invalid regex stored in the pack — surface but do not block.
        // eslint-disable-next-line no-console
        console.warn(`[import] invalid pattern for ${field.key}: ${field.pattern}`);
      }
    }
  }

  return errors;
}

/**
 * Apply column mapping to a raw row, returning the mapped data object.
 */
export function applyMapping(
  row: Record<string, string>,
  mapping: Record<string, string>,
  fieldDefinitions: FieldDefinition[]
): Record<string, any> {
  const result: Record<string, any> = {};

  for (const [header, fieldKey] of Object.entries(mapping)) {
    if (!fieldKey) continue;
    const field = fieldDefinitions.find((f) => f.key === fieldKey);
    const rawValue = row[header] || "";

    if (!rawValue) continue;

    if (field?.type === "number") {
      result[fieldKey] = Number(rawValue);
    } else if (field?.type === "select") {
      result[fieldKey] = rawValue.toLowerCase();
    } else {
      result[fieldKey] = rawValue;
    }
  }

  return result;
}

/**
 * Generate and download a blank CSV template for the given field definitions.
 */
export function downloadTemplate(entityName: string, fieldDefinitions: FieldDefinition[]) {
  const headers = fieldDefinitions.map((f) => f.label);
  // RENDERER-EXEMPT: blank import template, not a report artifact. Milestone C.2's
  // no-raw-xlsx-in-app rule targets report generation; import scaffolds stay client-side.
  const ws = XLSX.utils.aoa_to_sheet([headers]);
  // RENDERER-EXEMPT: import template scaffold (see above).
  const wb = XLSX.utils.book_new();
  // RENDERER-EXEMPT: import template scaffold (see above).
  XLSX.utils.book_append_sheet(wb, ws, entityName);
  // RENDERER-EXEMPT: import template scaffold (see above).
  XLSX.writeFile(wb, `${entityName}_Import_Template.csv`, { bookType: "csv" });
}

/**
 * Download failed rows as a CSV error report.
 */
export function downloadErrorReport(
  failedRows: { rowIndex: number; data: Record<string, any>; errors: string }[]
) {
  if (failedRows.length === 0) return;

  const headers = [...Object.keys(failedRows[0].data), "Errors"];
  const rows = failedRows.map((r) => [...Object.values(r.data), r.errors]);

  // RENDERER-EXEMPT: per-import error report, not a report artifact (Milestone C.2).
  const ws = XLSX.utils.aoa_to_sheet([headers, ...rows]);
  // RENDERER-EXEMPT: per-import error report (see above).
  const wb = XLSX.utils.book_new();
  // RENDERER-EXEMPT: per-import error report (see above).
  XLSX.utils.book_append_sheet(wb, ws, "Errors");
  // RENDERER-EXEMPT: per-import error report (see above).
  XLSX.writeFile(wb, "Import_Errors.csv", { bookType: "csv" });
}
