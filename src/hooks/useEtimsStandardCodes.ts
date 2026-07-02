import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "./useOrganization";

export interface EtimsStandardCode {
  id: string;
  code_type: string;
  code: string;
  name: string;
  description: string | null;
}

// Common eTIMS Unit Codes (these rarely change, so static is fine)
export const ETIMS_UNIT_CODES = [
  { code: "U", name: "Unit", description: "Single unit/piece" },
  { code: "KG", name: "Kilogram", description: "Weight in kilograms" },
  { code: "LT", name: "Litre", description: "Volume in litres" },
  { code: "M", name: "Metre", description: "Length in metres" },
  { code: "M2", name: "Square Metre", description: "Area in square metres" },
  { code: "M3", name: "Cubic Metre", description: "Volume in cubic metres" },
  { code: "DZ", name: "Dozen", description: "12 units" },
  { code: "GR", name: "Gram", description: "Weight in grams" },
  { code: "ML", name: "Millilitre", description: "Volume in millilitres" },
  { code: "SET", name: "Set", description: "Set of items" },
  { code: "PR", name: "Pair", description: "Pair of items" },
  { code: "HR", name: "Hour", description: "Time in hours" },
  { code: "DAY", name: "Day", description: "Time in days" },
] as const;

// Common eTIMS Packaging Unit Codes (these rarely change, so static is fine)
export const ETIMS_PACKAGING_CODES = [
  { code: "CT", name: "Carton", description: "Carton box" },
  { code: "BG", name: "Bag", description: "Bag/sack" },
  { code: "BX", name: "Box", description: "Box" },
  { code: "PK", name: "Pack", description: "Package/pack" },
  { code: "RL", name: "Roll", description: "Roll" },
  { code: "BT", name: "Bottle", description: "Bottle" },
  { code: "CN", name: "Can", description: "Can/tin" },
  { code: "DR", name: "Drum", description: "Drum/barrel" },
  { code: "EA", name: "Each", description: "Each/piece" },
  { code: "CS", name: "Case", description: "Case" },
] as const;

export type EtimsUnitCode = typeof ETIMS_UNIT_CODES[number]["code"];
export type EtimsPackagingCode = typeof ETIMS_PACKAGING_CODES[number]["code"];

export function useEtimsStandardCodes(codeType?: string) {
  const { currentOrg } = useOrganization();

  const { data: codes, isLoading } = useQuery({
    queryKey: ["etims-standard-codes", currentOrg?.id, codeType],
    queryFn: async () => {
      if (!currentOrg) return [];

      let query = supabase
        .from("etims_standard_codes")
        .select("*")
        .order("code");

      if (codeType) {
        query = query.eq("code_type", codeType);
      }

      const { data, error } = await query;
      if (error) {
        console.error("Error fetching eTIMS standard codes:", error);
        return [];
      }
      return data as EtimsStandardCode[];
    },
    enabled: !!currentOrg,
  });

  // Get classification codes (item categories)
  const classificationCodes = codes?.filter(c => c.code_type === "item_classification") || [];

  // Get country codes
  const countryCodes = codes?.filter(c => c.code_type === "country") || [];

  return {
    codes: codes || [],
    classificationCodes,
    countryCodes,
    isLoading,
    // Static code lookups (unit/packaging rarely change)
    unitCodes: ETIMS_UNIT_CODES,
    packagingCodes: ETIMS_PACKAGING_CODES,
    // Helper functions
    getUnitCodeLabel: (code: string) => {
      const unitCode = ETIMS_UNIT_CODES.find(u => u.code === code);
      return unitCode ? `${unitCode.code} - ${unitCode.name}` : code;
    },
    getPackagingCodeLabel: (code: string) => {
      const pkgCode = ETIMS_PACKAGING_CODES.find(p => p.code === code);
      return pkgCode ? `${pkgCode.code} - ${pkgCode.name}` : code;
    },
  };
}
