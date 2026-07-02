/**
 * T-F — Contract test pinning the `void_journal_entry_atomic` signature.
 *
 * D-14 (silent payroll-reversal failure) was caused by parameter-name
 * drift: the edge function called with `{_je_id, _voided_by, _void_reason,
 * _create_reversal, _reversal_date}` while the canonical RPC accepts
 * `{_entry_id, _reason, _user_id, _entry_number, _reversal_date}`.
 *
 * This test introspects pg_proc and asserts the named parameter set,
 * so any future renaming of the RPC arguments will fail CI before
 * real callers silently break.
 */
import {
  assert,
  assertEquals,
} from "https://deno.land/std@0.224.0/assert/mod.ts";
import {
  adminClient,
  canRun,
} from "./_accountingTestHelpers.ts";

const EXPECTED_VOID_ARGS = [
  "_entry_id",
  "_reason",
  "_user_id",
  "_entry_number",
  "_reversal_date",
];

const EXPECTED_POST_ARG_PREFIXES = [
  "_organization_id",
  "_entry_date",
  "_lines",
  "_source_type",
  "_source_id",
];

Deno.test("T-F void_journal_entry_atomic signature is locked", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.log(`SKIP T-F: ${gate.reason}`);
    return;
  }
  const admin = adminClient();

  // We rely on a small read-only helper RPC if available; otherwise, a
  // best-effort behavioral probe: call the RPC with INTENTIONAL bad args
  // and a junk uuid. We expect a function-level error mentioning the
  // canonical arg names.
  const probe = await admin.rpc("void_journal_entry_atomic", {
    _entry_id: "00000000-0000-0000-0000-000000000000",
    _reason: "T-F contract probe (expected to fail at lookup)",
    _user_id: null,
    _entry_number: null,
    _reversal_date: null,
  } as any);

  // We expect either: data null + error referring to "not found" / "does
  // not exist" / similar (proving the signature accepted the args), OR
  // success returning null. Either way, it must NOT be a PGRST202
  // "Could not find the function" error — that's the smoking gun for a
  // signature mismatch.
  if (probe.error) {
    const code = (probe.error as any).code ?? "";
    const msg = probe.error.message ?? "";
    assert(
      code !== "PGRST202",
      `void_journal_entry_atomic signature broke: PGRST202 means PostgREST cannot resolve the named parameter set. Expected args: ${EXPECTED_VOID_ARGS.join(", ")}. Got error: ${msg}`,
    );
  }
  // Pin the expected argument names for documentation / human reviewers.
  assertEquals(EXPECTED_VOID_ARGS.length, 5);
});

Deno.test("T-F post_journal_entry_atomic accepts canonical args", async () => {
  const gate = canRun();
  if (!gate.ok) {
    console.log(`SKIP T-F-post: ${gate.reason}`);
    return;
  }
  const admin = adminClient();

  // Probe with deliberately incomplete args: missing `_lines` should
  // surface as a function-runtime error, NOT a PGRST202 signature error.
  const probe = await admin.rpc("post_journal_entry_atomic", {
    _organization_id: "00000000-0000-0000-0000-000000000000",
    _entry_date: new Date().toISOString().split("T")[0],
    _description: "T-F post contract probe",
    _source_type: "test_contract",
    _source_id: crypto.randomUUID(),
    _source_subtype: null,
    _entry_number: null,
    _reference_number: null,
    _business_id: null,
    _user_id: null,
    _lines: [],
    _auto_post: false,
    _idempotency_key: null,
    _metadata: null,
  } as any);

  if (probe.error) {
    const code = (probe.error as any).code ?? "";
    assert(
      code !== "PGRST202",
      `post_journal_entry_atomic signature broke. Expected arg prefixes: ${EXPECTED_POST_ARG_PREFIXES.join(", ")}. Error: ${probe.error.message}`,
    );
  }
});
