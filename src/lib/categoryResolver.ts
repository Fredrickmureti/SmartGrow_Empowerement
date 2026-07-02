import { supabase } from "@/integrations/supabase/client";

/**
 * Resolves category paths (e.g. "Electronics / Computers") to category IDs,
 * auto-creating missing categories along the way (Odoo-style).
 */
export class CategoryResolver {
  private organizationId: string;
  private businessId: string;
  // Cache key format: "parentId|lowercaseName" -> categoryId
  private cache = new Map<string, string>();

  constructor(organizationId: string, businessId: string, existingCategories?: { id: string; name: string; parent_id: string | null }[]) {
    this.organizationId = organizationId;
    this.businessId = businessId;

    // Pre-populate cache from existing categories
    if (existingCategories) {
      for (const cat of existingCategories) {
        const key = this.cacheKey(cat.parent_id, cat.name);
        this.cache.set(key, cat.id);
      }
    }
  }

  private cacheKey(parentId: string | null, name: string): string {
    return `${parentId || "root"}|${name.toLowerCase().trim()}`;
  }

  /**
   * Resolve a category path string to a category ID.
   * Supports nested paths separated by "/" (e.g. "Electronics / Computers").
   * Creates any missing categories automatically.
   */
  async resolve(categoryPath: string): Promise<string> {
    const parts = categoryPath.split("/").map((p) => p.trim()).filter(Boolean);
    if (parts.length === 0) {
      throw new Error("Empty category path");
    }

    let parentId: string | null = null;

    for (const part of parts) {
      parentId = await this.resolveLevel(part, parentId);
    }

    return parentId!;
  }

  private async resolveLevel(name: string, parentId: string | null): Promise<string> {
    const key = this.cacheKey(parentId, name);

    // 1. Check cache
    const cached = this.cache.get(key);
    if (cached) return cached;

    // 2. Query DB (case-insensitive)
    let query = supabase
      .from("product_categories")
      .select("id, name")
      .eq("organization_id", this.organizationId)
      .eq("business_id", this.businessId)
      .ilike("name", name);

    if (parentId) {
      query = query.eq("parent_id", parentId);
    } else {
      query = query.is("parent_id", null);
    }

    const { data: existing, error: selectError } = await query.limit(1);
    if (selectError) throw new Error(`Category lookup failed: ${selectError.message}`);

    if (existing && existing.length > 0) {
      this.cache.set(key, existing[0].id);
      return existing[0].id;
    }

    // 3. Auto-create
    const { data: created, error: insertError } = await supabase
      .from("product_categories")
      .insert({
        organization_id: this.organizationId,
        business_id: this.businessId,
        name: name,
        parent_id: parentId,
      })
      .select("id")
      .single();

    if (insertError) throw new Error(`Category creation failed: ${insertError.message}`);

    this.cache.set(key, created.id);
    return created.id;
  }
}
