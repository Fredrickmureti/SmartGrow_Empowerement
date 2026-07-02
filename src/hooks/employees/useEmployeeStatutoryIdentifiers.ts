/**
 * useEmployeeStatutoryIdentifiers — pack/data-driven statutory identifier
 * rows for an employee. Replaces the legacy `statutoryLabelsFor(country)`
 * country switch. NO country branches: the table itself is the source of
 * truth (`employee_statutory_identifiers.identifier_type`); the hook just
 * humanises `identifier_type` for display.
 *
 * Phase 3 hardening: payroll/HR UI must never re-encode a country→label
 * map in TypeScript. Adding a new identifier for a new country is a row
 * INSERT plus optionally a pretty-label entry in `KNOWN_IDENTIFIER_LABELS`
 * below (free-form, no logic branches).
 */
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";

export interface StatutoryIdentifierRow {
  id: string;
  identifier_type: string;
  identifier_value: string;
  country_code: string | null;
  label: string;
}

// Pretty-print map for known identifier_type codes. Free-form: adding a
// new one is a single line; no branching logic, no country awareness.
// Anything not in this map is humanised by replacing underscores and
// upper-casing acronyms — never produces a wrong label, just a less
// polished one until added here.
const KNOWN_IDENTIFIER_LABELS: Record<string, string> = {
  tax_pin: "Tax PIN",
  tax_id: "Tax ID",
  tin: "TIN",
  ssn: "SSN",
  ein: "EIN",
  utr: "UTR",
  nino: "National Insurance No.",
  nhs: "NHS Number",
  nssf: "NSSF Number",
  shif: "SHIF Number",
  nhif: "NHIF Number",
  pssf: "PSSSF Number",
  psssf: "PSSSF Number",
  rssb: "RSSB Number",
  uif: "UIF Number",
  pension_pin: "Pension PIN",
  nhis: "NHIS Number",
  ahl: "AHL Reference",
  housing_levy: "Housing Levy Reference",
  social_security: "Social Security No.",
  health_insurance: "Health Insurance No.",
  medical_aid: "Medical Aid No.",
};

const ACRONYMS = new Set(["nssf", "shif", "nhif", "tin", "ssn", "ein", "utr", "uif", "rssb", "psssf", "pssf", "nhs", "nhis", "ahl"]);

function humanise(code: string): string {
  return code
    .split(/[_\s]+/)
    .filter(Boolean)
    .map((p) => (ACRONYMS.has(p.toLowerCase()) ? p.toUpperCase() : p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()))
    .join(" ");
}

export function labelForIdentifier(identifier_type: string): string {
  return KNOWN_IDENTIFIER_LABELS[identifier_type.toLowerCase()] ?? humanise(identifier_type);
}

export function useEmployeeStatutoryIdentifiers(employeeId: string | null | undefined) {
  return useQuery({
    queryKey: ["employee-statutory-identifiers", employeeId],
    enabled: !!employeeId,
    queryFn: async (): Promise<StatutoryIdentifierRow[]> => {
      const { data, error } = await (supabase as any)
        .from("employee_statutory_identifiers")
        .select("id, identifier_type, identifier_value, country_code, is_active")
        .eq("employee_id", employeeId)
        .eq("is_active", true);
      if (error) throw error;
      return (data ?? []).map((r: any) => ({
        id: r.id,
        identifier_type: r.identifier_type,
        identifier_value: r.identifier_value,
        country_code: r.country_code,
        label: labelForIdentifier(r.identifier_type),
      }));
    },
  });
}
