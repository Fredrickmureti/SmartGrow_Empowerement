/**
 * Seed helper stub. The real deterministic seed lands in Phase 14b as a
 * `is_sample_data = true` migration. This helper exists now so specs
 * written in 14b–14g reference a stable API from day one.
 *
 * Contract (14b): calling `ensureSeed(page)` guarantees the sample
 * business's warehouse, zones, bins, products, lots, carrier, dock,
 * carton type, QC reason, and labour standards are present.
 * Idempotent — safe to call from every `beforeAll`.
 */
import type { Page } from "@playwright/test";

export async function ensureSeed(_page: Page): Promise<void> {
  // Phase 14b — replace with an RPC call to `wms_e2e_ensure_seed` (or
  // equivalent) once the seed migration lands. Kept as a stub so specs
  // can `import { ensureSeed }` today without breaking the harness.
}
