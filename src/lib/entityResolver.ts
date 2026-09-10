import { supabase } from "@/integrations/supabase/client";

/**
 * Generic entity resolver for import operations.
 * Resolves entity names to IDs, auto-creating missing entities.
 */

interface ResolvedEntity {
  id: string;
  wasCreated: boolean;
}

/**
 * Resolve an account by code or name (case-insensitive).
 * Auto-creates if not found.
 */
export class AccountResolver {
  private organizationId: string;
  private businessId: string;
  private cache = new Map<string, string>();

  constructor(
    organizationId: string,
    businessId: string,
    existingAccounts?: { id: string; code: string; name: string }[]
  ) {
    this.organizationId = organizationId;
    this.businessId = businessId;
    if (existingAccounts) {
      for (const a of existingAccounts) {
        this.cache.set(a.code.toLowerCase().trim(), a.id);
        this.cache.set(`name:${a.name.toLowerCase().trim()}`, a.id);
      }
    }
  }

  async resolve(codeOrName: string, accountType?: string): Promise<ResolvedEntity> {
    if (!this.businessId) {
      throw new Error("AccountResolver requires a businessId — accounts are company-scoped.");
    }
    const key = codeOrName.toLowerCase().trim();
    if (!key) throw new Error("Empty account code/name");

    const cached = this.cache.get(key) || this.cache.get(`name:${key}`);
    if (cached) return { id: cached, wasCreated: false };

    // Query by code
    const { data: byCode } = await supabase
      .from("accounts")
      .select("id")
      .eq("organization_id", this.organizationId)
      .eq("business_id", this.businessId)
      .ilike("code", codeOrName.trim())
      .limit(1);

    if (byCode && byCode.length > 0) {
      this.cache.set(key, byCode[0].id);
      return { id: byCode[0].id, wasCreated: false };
    }

    // Query by name
    const { data: byName } = await supabase
      .from("accounts")
      .select("id")
      .eq("organization_id", this.organizationId)
      .eq("business_id", this.businessId)
      .ilike("name", codeOrName.trim())
      .limit(1);

    if (byName && byName.length > 0) {
      this.cache.set(key, byName[0].id);
      return { id: byName[0].id, wasCreated: false };
    }

    // Auto-create with generated code
    const code = codeOrName.trim().substring(0, 10).toUpperCase().replace(/\s+/g, "-");
    const { data: created, error } = await supabase
      .from("accounts")
      .insert({
        organization_id: this.organizationId,
        business_id: this.businessId,
        code: `IMP-${code}-${Date.now().toString(36).slice(-4)}`,
        name: codeOrName.trim(),
        account_type: (accountType as any) || "expense",
        is_active: true,
        is_system: false,
        opening_balance: 0,
        current_balance: 0,
      })
      .select("id")
      .single();

    if (error) throw new Error(`Account creation failed: ${error.message}`);

    this.cache.set(key, created.id);
    return { id: created.id, wasCreated: true };
  }
}
