/**
 * Shared types for the localization-pack platform.
 * Consumed by both the platform/admin editor and the tenant editor.
 */
export type ComputationKind =
  | "progressive"
  | "tiered"
  | "percentage"
  | "graduated"
  | "fixed"
  | "flat";

export type RuleType =
  | "income_tax"
  | "statutory_deduction"
  | "employer_contribution";

export interface PackRuleSchema {
  id: string;
  rule_type: RuleType | string;
  computation_kind: ComputationKind | string;
  schema_version: number;
  json_schema: any;
  ui_schema: any | null;
  token_outputs: string[];
  description: string | null;
}

export interface PackToken {
  id: string;
  pack_id: string | null;
  token_path: string;
  source: "employee" | "contract" | "run" | "rule_output" | "constant" | "system";
  data_type: "string" | "number" | "date" | "boolean" | "currency";
  sample_value: any;
  description: string | null;
  deprecated_in_version: string | null;
  replaces: string | null;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
  warnings: string[];
}

export type EditorMode = "admin" | "tenant";
