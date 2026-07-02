// Deno tests for the accept-invitation edge function.
//
// Exercises the structured `code` outcomes the frontend now switches on.
// Run via supabase--test_edge_functions { functions: ["accept-invitation"] }.

import "https://deno.land/std@0.224.0/dotenv/load.ts";
import { assertEquals } from "https://deno.land/std@0.224.0/assert/mod.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.4";

const SUPABASE_URL = Deno.env.get("VITE_SUPABASE_URL")!;
const ANON_KEY = Deno.env.get("VITE_SUPABASE_PUBLISHABLE_KEY")!;
const SERVICE_ROLE_KEY =
  Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ??
  Deno.env.get("VITE_SUPABASE_SERVICE_ROLE_KEY") ??
  "";

const FN_URL = `${SUPABASE_URL}/functions/v1/accept-invitation`;

const admin = SERVICE_ROLE_KEY
  ? createClient(SUPABASE_URL, SERVICE_ROLE_KEY)
  : null;

async function post(body: unknown, headers: Record<string, string> = {}) {
  const res = await fetch(FN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: ANON_KEY,
      ...headers,
    },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => ({}));
  return { status: res.status, json };
}

Deno.test("missing token → 400 invalid", async () => {
  const { status, json } = await post({});
  assertEquals(status, 400);
  assertEquals(json.code, "invalid");
});

Deno.test("unknown token → 404 invalid", async () => {
  const { status, json } = await post({ token: "definitely-not-a-real-token-xyz" });
  assertEquals(status, 404);
  assertEquals(json.code, "invalid");
});

Deno.test("no JWT and no create_account → 401 login_required", async () => {
  if (!admin) {
    console.warn("Skipping: SERVICE_ROLE_KEY missing");
    return;
  }
  const { token, cleanup } = await seedPendingInvite();
  try {
    const { status, json } = await post({ token });
    assertEquals(status, 401);
    assertEquals(json.code, "login_required");
  } finally {
    await cleanup();
  }
});

Deno.test("create_account with mismatched email → 400 email_mismatch", async () => {
  if (!admin) {
    console.warn("Skipping: SERVICE_ROLE_KEY missing");
    return;
  }
  const { token, cleanup } = await seedPendingInvite();
  try {
    const { status, json } = await post({
      token,
      create_account: true,
      email: `someoneelse-${crypto.randomUUID()}@example.com`,
      password: "TempPass!23456",
      full_name: "Wrong Person",
    });
    assertEquals(status, 400);
    assertEquals(json.code, "email_mismatch");
  } finally {
    await cleanup();
  }
});

Deno.test("expired invitation → 400 expired", async () => {
  if (!admin) {
    console.warn("Skipping: SERVICE_ROLE_KEY missing");
    return;
  }
  const { token, cleanup } = await seedPendingInvite({ expired: true });
  try {
    const { status, json } = await post({ token });
    assertEquals(status, 400);
    assertEquals(json.code, "expired");
  } finally {
    await cleanup();
  }
});

Deno.test("already-accepted invitation → 400 already_accepted", async () => {
  if (!admin) {
    console.warn("Skipping: SERVICE_ROLE_KEY missing");
    return;
  }
  const { token, cleanup } = await seedPendingInvite({ accepted: true });
  try {
    const { status, json } = await post({ token });
    assertEquals(status, 400);
    assertEquals(json.code, "already_accepted");
  } finally {
    await cleanup();
  }
});

Deno.test("create_account when auth user already exists → 200 login_required", async () => {
  if (!admin) {
    console.warn("Skipping: SERVICE_ROLE_KEY missing");
    return;
  }
  const email = `existing-${crypto.randomUUID()}@example.com`;
  const { data: created, error: createErr } = await admin.auth.admin.createUser({
    email,
    password: "TempPass!23456",
    email_confirm: true,
  });
  if (createErr) throw createErr;
  const userId = created.user!.id;

  const { token, cleanup } = await seedPendingInvite({ email });
  try {
    const { status, json } = await post({
      token,
      create_account: true,
      email,
      password: "TempPass!23456",
      full_name: "Existing User",
    });
    assertEquals(status, 200);
    assertEquals(json.code, "login_required");
  } finally {
    await cleanup();
    await admin.auth.admin.deleteUser(userId).catch(() => {});
  }
});

// ----- seed helpers -----

async function seedPendingInvite(opts?: {
  email?: string;
  expired?: boolean;
  accepted?: boolean;
}): Promise<{ token: string; cleanup: () => Promise<void> }> {
  const a = admin!;
  // Pick any existing organization — we only need a valid FK.
  const { data: orgs, error: orgErr } = await a
    .from("organizations")
    .select("id")
    .limit(1);
  if (orgErr) throw orgErr;
  if (!orgs?.length) throw new Error("No organization available for test seed");

  const token = `test-${crypto.randomUUID()}`;
  const email = (opts?.email ?? `invite-${crypto.randomUUID()}@example.com`).toLowerCase();
  const expiresAt = opts?.expired
    ? new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString()
    : new Date(Date.now() + 7 * 24 * 60 * 60 * 1000).toISOString();

  const { data: invite, error: insErr } = await a
    .from("organization_invitations")
    .insert({
      organization_id: orgs[0].id,
      email,
      role: "internal",
      user_type: "internal",
      token,
      expires_at: expiresAt,
      accepted_at: opts?.accepted ? new Date().toISOString() : null,
    } as any)
    .select("id")
    .single();
  if (insErr) throw insErr;

  return {
    token,
    cleanup: async () => {
      await a.from("organization_invitations").delete().eq("id", invite.id);
    },
  };
}
