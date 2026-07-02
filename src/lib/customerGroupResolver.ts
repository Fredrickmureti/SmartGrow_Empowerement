import { supabase } from "@/integrations/supabase/client";

/**
 * Resolves customer group names to IDs, auto-creating missing groups.
 * Modeled after CategoryResolver for products.
 */
export class CustomerGroupResolver {
  private organizationId: string;
  private businessId: string;
  private cache = new Map<string, string>();

  constructor(
    organizationId: string,
    businessId: string,
    existingGroups?: { id: string; name: string }[]
  ) {
    this.organizationId = organizationId;
    this.businessId = businessId;

    if (existingGroups) {
      for (const group of existingGroups) {
        this.cache.set(group.name.toLowerCase().trim(), group.id);
      }
    }
  }

  /**
   * Resolve a group name to a group ID.
   * Creates the group if it doesn't exist.
   */
  async resolve(groupName: string): Promise<string> {
    const normalized = groupName.toLowerCase().trim();
    if (!normalized) throw new Error("Empty group name");

    // 1. Check cache
    const cached = this.cache.get(normalized);
    if (cached) return cached;

    // 2. Query DB (case-insensitive)
    const { data: existing, error: selectError } = await supabase
      .from("customer_groups")
      .select("id, name")
      .eq("organization_id", this.organizationId)
      .eq("business_id", this.businessId)
      .ilike("name", groupName.trim())
      .limit(1);

    if (selectError) throw new Error(`Group lookup failed: ${selectError.message}`);

    if (existing && existing.length > 0) {
      this.cache.set(normalized, existing[0].id);
      return existing[0].id;
    }

    // 3. Auto-create
    const { data: created, error: insertError } = await supabase
      .from("customer_groups")
      .insert({
        organization_id: this.organizationId,
        business_id: this.businessId,
        name: groupName.trim(),
        is_active: true,
        discount_percent: 0,
        sort_order: 0,
      })
      .select("id")
      .single();

    if (insertError) throw new Error(`Group creation failed: ${insertError.message}`);

    this.cache.set(normalized, created.id);
    return created.id;
  }
}
