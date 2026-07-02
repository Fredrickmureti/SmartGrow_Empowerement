import { supabase } from "@/integrations/supabase/client";

/**
 * Resolves department names to IDs, auto-creating missing departments.
 * Used during employee import to properly set department_id FK.
 */
export class DepartmentResolver {
  private organizationId: string;
  private businessId: string | null;
  private cache = new Map<string, string>();

  constructor(
    organizationId: string,
    businessId: string | null,
    existingDepartments?: { id: string; name: string }[]
  ) {
    this.organizationId = organizationId;
    this.businessId = businessId;
    if (existingDepartments) {
      for (const dept of existingDepartments) {
        this.cache.set(dept.name.toLowerCase().trim(), dept.id);
      }
    }
  }

  async resolve(departmentName: string): Promise<string> {
    const key = departmentName.toLowerCase().trim();
    if (!key) throw new Error("Empty department name");

    // 1. Check cache
    const cached = this.cache.get(key);
    if (cached) return cached;

    // 2. Query DB (case-insensitive)
    let query = supabase
      .from("departments")
      .select("id, name")
      .eq("organization_id", this.organizationId)
      .ilike("name", departmentName.trim())
      .limit(1);

    if (this.businessId) {
      query = query.eq("business_id", this.businessId);
    }

    const { data: existing } = await query;

    if (existing && existing.length > 0) {
      this.cache.set(key, existing[0].id);
      return existing[0].id;
    }

    // 3. Auto-create department
    const { data: created, error } = await supabase
      .from("departments")
      .insert({
        organization_id: this.organizationId,
        business_id: this.businessId,
        name: departmentName.trim(),
        is_active: true,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Department creation failed: ${error.message}`);

    this.cache.set(key, created.id);
    return created.id;
  }
}
