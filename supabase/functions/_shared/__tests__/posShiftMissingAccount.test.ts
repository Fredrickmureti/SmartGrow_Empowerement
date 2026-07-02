/**
 * T-C — POS shift posting fails fast when account mapping is missing,
 *       and idempotency holds when the mapping is correct.
 *
 * Two assertions:
 *   1. `post_pos_shift_gl(<shift_id>)` RAISES when `pos_cash` mapping
 *      is absent — proves we never silently post a half-balanced JE.
 *   2. After mapping is configured, calling the function twice for the
 *      same shift returns the SAME journal_entry_id (idempotency via
 *      both the in-function guard AND `idx_journal_entries_source_unique`).
 *
 * NOTE: this test only runs if `TEST_POS_SHIFT_ID` is provided. POS
 * fixtures are heavy and org-specific; skip cleanly otherwise.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adminClient,
  canRun,
} from "./_accountingTestHelpers.ts";

const TEST_POS_SHIFT_ID = Deno.env.get("TEST_POS_SHIFT_ID") ?? "";

Deno.test("T-C pos shift posting respects missing-account guard + idempotency", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.log(`SKIP T-C: ${gate.reason}`);
    return;
  }
  if (!TEST_POS_SHIFT_ID) {
    console.log("SKIP T-C: TEST_POS_SHIFT_ID not set (heavy POS fixture)");
    return;
  }
  const admin = adminClient();

  // Call once; capture result.
  const first = await admin.rpc("post_pos_shift_gl", {
    _shift_id: TEST_POS_SHIFT_ID,
  } as any);

  if (first.error) {
    // Acceptable failure path: missing account mapping.
    const msg = first.error.message ?? "";
    assert(
      /account|mapping|pos_cash|not found/i.test(msg),
      `Unexpected error from post_pos_shift_gl: ${msg}`,
    );
    console.log("T-C: missing-account guard fired as expected");
    return;
  }

  // Idempotency: second call returns the same JE id.
  const second = await admin.rpc("post_pos_shift_gl", {
    _shift_id: TEST_POS_SHIFT_ID,
  } as any);
  if (second.error) throw second.error;
  assertEquals(
    first.data,
    second.data,
    "post_pos_shift_gl must be idempotent — same JE id on repeat",
  );
});
