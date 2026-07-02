import { useMemo } from "react";
import { useBusinesses } from "@/hooks/useBusinesses";
import {
  getIndustryProfile,
  type IndustryProfile,
} from "@/lib/industryProfiles";

/**
 * Reads the current business's `industry` and resolves it into an
 * {@link IndustryProfile} of UX defaults. Reactive to business switches.
 */
export function useIndustryProfile(): {
  industry: string | null;
  profile: IndustryProfile;
} {
  const { currentBusiness } = useBusinesses();
  const industry = (currentBusiness?.industry ?? null) as string | null;
  const profile = useMemo(() => getIndustryProfile(industry), [industry]);
  return { industry, profile };
}
