import { FieldDefinition } from "@/lib/importUtils";
import { normalizeAccountType } from "@/lib/migration/sourceSystemPresets";
import { supabase } from "@/integrations/supabase/client";
import { resolveDetailTypeFromName } from "@/lib/accountDetailTypes";

/**
 * Canonical account field definitions for CSV/XLSX import.
 * Used by BOTH the Accounts page import AND the Migration step.
 *
 * DO NOT duplicate this. If you need account import anywhere,
 * import from this file.
 */
export const ACCOUNT_IMPORT_FIELDS: FieldDefinition[] = [
  { key: "code", label: "Account Code", required: true, type: "text", aliases: ["account_code", "acct_code", "number", "Acct Code", "Account Number", "Acc Code"] },
  { key: "name", label: "Account Name", required: true, type: "text", aliases: ["account_name", "acct_name", "description", "Name", "Account"] },
  { key: "account_type", label: "Account Type", required: true, type: "select", aliases: ["type", "category", "Type", "Category"], options: ["asset", "liability", "equity", "income", "expense"], allowFallback: true, fallbackValue: "asset" },
  { key: "detail_type", label: "Detail Type", required: false, type: "text", aliases: ["Detail Type", "Sub Type", "Subtype", "Account Subtype", "Detail"] },
  { key: "description", label: "Description", required: false, type: "text", aliases: ["desc", "notes", "memo", "Notes", "Memo", "Details"] },
  { key: "opening_balance", label: "Opening Balance", required: false, type: "number", aliases: ["balance", "Opening Bal", "Starting Balance"] },
  { key: "parent_code", label: "Parent Account Code", required: false, type: "text", aliases: ["Parent", "Parent Account", "Parent Code"] },
];

/**
 * Minimal migration subset — excludes opening_balance (handled via Trial Balance GL posting)
 * and parent_code (not typically in migration CSVs).
 */
export const ACCOUNT_MIGRATION_FIELDS: FieldDefinition[] = ACCOUNT_IMPORT_FIELDS.filter(
  f => !["opening_balance", "parent_code"].includes(f.key)
);

/**
 * Creates an account import handler for the migration step (row-by-row).
 * Normalizes account types from source systems (Odoo, QuickBooks, etc.)
 * and resolves detail_type using name-based keyword matching when not provided.
 */
export function createAccountMigrationHandler(orgId: string, businessId: string) {
  return async (row: Record<string, any>) => {
    if (!businessId) {
      throw new Error("No active company selected. Please select a company before importing accounts.");
    }
    const rawType = (row.account_type || "").trim();
    const mappedType = normalizeAccountType(rawType);
    if (!mappedType) {
      throw new Error(`Unknown account type "${rawType}". Expected: asset, liability, equity, revenue, or expense.`);
    }

    // Resolve detail_type: use explicit value if provided, otherwise auto-resolve from name
    const detailType = row.detail_type
      ? row.detail_type.toLowerCase().replace(/[\s-]/g, "_")
      : resolveDetailTypeFromName(mappedType, row.name || "");

    const { error } = await supabase.from("accounts").insert({
      organization_id: orgId,
      business_id: businessId,
      code: row.code,
      name: row.name,
      account_type: mappedType,
      detail_type: detailType || null,
      description: row.description || null,
    });
    if (error) throw error;
  };
}

/**
 * Batch account import handler for the migration step.
 * Uses multi-row insert for performance with large files.
 */
export function createAccountBatchMigrationHandler(orgId: string, businessId: string) {
  return async (rows: Record<string, any>[]) => {
    if (!businessId) {
      throw new Error("No active company selected. Please select a company before importing accounts.");
    }
    const validRows: any[] = [];
    const errors: { rowIndex: number; data: Record<string, any>; errors: string }[] = [];

    rows.forEach((row, i) => {
      const rawType = (row.account_type || "").trim();
      const mappedType = normalizeAccountType(rawType);
      if (!mappedType) {
        errors.push({ rowIndex: i + 2, data: row, errors: `Unknown account type "${rawType}"` });
        return;
      }
      // Resolve detail_type: use explicit value if provided, otherwise auto-resolve from name
      const detailType = row.detail_type
        ? row.detail_type.toLowerCase().replace(/[\s-]/g, "_")
        : resolveDetailTypeFromName(mappedType, row.name || "");

      validRows.push({
        organization_id: orgId,
        business_id: businessId,
        code: row.code,
        name: row.name,
        account_type: mappedType,
        detail_type: detailType || null,
        description: row.description || null,
      });
    });

    // Batch insert in chunks of 200
    const CHUNK = 200;
    let imported = 0;
    for (let i = 0; i < validRows.length; i += CHUNK) {
      const chunk = validRows.slice(i, i + CHUNK);
      const { error } = await supabase.from("accounts").insert(chunk);
      if (error) {
        // Fall back to row-by-row for this chunk to isolate failures
        for (const row of chunk) {
          const { error: rowErr } = await supabase.from("accounts").insert(row);
          if (rowErr) {
            errors.push({ rowIndex: i + 2, data: row, errors: rowErr.message });
          } else {
            imported++;
          }
        }
      } else {
        imported += chunk.length;
      }
    }

    return { total: rows.length, imported, skipped: errors.length, errors };
  };
}
