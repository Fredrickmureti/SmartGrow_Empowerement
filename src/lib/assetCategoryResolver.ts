import { supabase } from "@/integrations/supabase/client";

/**
 * Resolves asset category names to IDs, auto-creating missing categories.
 * Follows the same pattern as CategoryResolver and CustomerGroupResolver.
 */
export class AssetCategoryResolver {
  private organizationId: string;
  private businessId: string;
  private cache = new Map<string, string>();

  constructor(
    organizationId: string,
    businessId: string,
    existingCategories?: { id: string; name: string }[]
  ) {
    this.organizationId = organizationId;
    this.businessId = businessId;
    if (existingCategories) {
      for (const cat of existingCategories) {
        this.cache.set(cat.name.toLowerCase().trim(), cat.id);
      }
    }
  }

  async resolve(
    categoryName: string,
    defaults?: {
      depreciation_method?: string;
      useful_life_years?: number;
      depreciation_rate?: number;
    }
  ): Promise<string> {
    const key = categoryName.toLowerCase().trim();
    if (!key) throw new Error("Empty asset category name");

    // 1. Check cache
    const cached = this.cache.get(key);
    if (cached) return cached;

    // 2. Query DB (case-insensitive)
    const { data: existing } = await supabase
      .from("asset_categories")
      .select("id, name")
      .eq("organization_id", this.organizationId)
      .eq("business_id", this.businessId)
      .ilike("name", categoryName.trim())
      .limit(1);

    if (existing && existing.length > 0) {
      this.cache.set(key, existing[0].id);
      return existing[0].id;
    }

    // 3. Auto-create with sensible defaults
    const { data: created, error } = await supabase
      .from("asset_categories")
      .insert({
        organization_id: this.organizationId,
        business_id: this.businessId,
        name: categoryName.trim(),
        depreciation_method: defaults?.depreciation_method || "straight_line",
        useful_life_years: defaults?.useful_life_years || 5,
        depreciation_rate: defaults?.depreciation_rate || 20,
        is_active: true,
      } as any)
      .select("id")
      .single();

    if (error) throw new Error(`Asset category creation failed: ${error.message}`);

    this.cache.set(key, created.id);
    return created.id;
  }
}
