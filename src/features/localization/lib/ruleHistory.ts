/**
 * Pure helpers that walk `pack_versions.snapshot` to reconstruct the
 * lifecycle of a single rule (or template) across pack versions.
 *
 * The snapshot shape is `{ [table_name]: row[] }` (see PackDiffView). A
 * rule lives under one of a few candidate tables depending on whether the
 * snapshot was authored by the admin (pack template) or copied from a
 * tenant override. We probe a small allow-list of tables so callers don't
 * need to know the storage detail.
 */
import type { PackVersion } from "../hooks/usePack";

export const RULE_SNAPSHOT_TABLES = [
  "localization_pack_payroll_templates",
  "payroll_statutory_rules",
  "pack_payroll_rules",
] as const;

export interface RuleHistoryEntry {
  version_id: string;
  version: string;
  published_at: string | null;
  effective_from?: string | null;
  effective_to?: string | null;
  parameters: any;
  rule_type?: string | null;
  description?: string | null;
  /** Raw snapshot row, kept so the UI can render extra fields if needed. */
  raw: any;
}

function findRuleInSnapshot(snapshot: any, ruleCode: string): any | null {
  if (!snapshot || typeof snapshot !== "object") return null;
  for (const t of RULE_SNAPSHOT_TABLES) {
    const rows = snapshot[t];
    if (!Array.isArray(rows)) continue;
    const hit = rows.find(
      (r: any) => r?.rule_code === ruleCode || r?.code === ruleCode || r?.rule_name === ruleCode,
    );
    if (hit) return hit;
  }
  // Fallback: scan every array-valued key.
  for (const k of Object.keys(snapshot)) {
    const rows = snapshot[k];
    if (!Array.isArray(rows)) continue;
    const hit = rows.find(
      (r: any) => r?.rule_code === ruleCode || r?.code === ruleCode || r?.rule_name === ruleCode,
    );
    if (hit) return hit;
  }
  return null;
}

/**
 * Returns the chronological history of `ruleCode` across the supplied
 * pack versions. Versions where the rule is absent are filtered out.
 * Sort is ascending by `published_at` (then `created_at` as fallback).
 */
export function traverseRuleHistory(
  versions: PackVersion[] | null | undefined,
  ruleCode: string,
): RuleHistoryEntry[] {
  if (!versions?.length || !ruleCode) return [];
  const sorted = [...versions].sort((a, b) => {
    const at = a.published_at ?? a.created_at;
    const bt = b.published_at ?? b.created_at;
    return new Date(at).getTime() - new Date(bt).getTime();
  });
  const out: RuleHistoryEntry[] = [];
  for (const v of sorted) {
    const row = findRuleInSnapshot(v.snapshot, ruleCode);
    if (!row) continue;
    out.push({
      version_id: v.id,
      version: v.version,
      published_at: v.published_at,
      effective_from: row.effective_from ?? row.parameters?.effective_from ?? null,
      effective_to: row.effective_to ?? row.parameters?.effective_to ?? null,
      parameters: row.parameters ?? row.body ?? null,
      rule_type: row.rule_type ?? null,
      description: row.description ?? null,
      raw: row,
    });
  }
  return out;
}