import { serve } from "https://deno.land/std@0.190.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";
import { runStorageGc } from "../_shared/storageGc.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type Mode = "wipe_all" | "categories" | "preview" | "delete_organization" | "gc_orphans";

interface ClearDataRequest {
  // Required for all modes EXCEPT gc_orphans (platform-wide sweep).
  organization_id?: string;
  mode?: Mode;
  /** wipe_all: `RESET-<org_id>`; delete_organization: `DELETE-<org_id>` */
  confirmation_token?: string;
  /** categories mode (new module names): pos, inventory, fixed_assets,
   *  vendor_returns, ancillaries, banking, transactions_ledger,
   *  sales, purchases, finance, sequences */
  categories?: string[];
  /** gc_orphans: when true (default), resolve and report but do not delete. */
  dry_run?: boolean;
  /** gc_orphans: minimum inferred-age before an orphan is eligible.
   *  Any Postgres interval literal. Default '0 seconds'. */
  grace_interval?: string;
}

/**
 * Always returns HTTP 200 so the Supabase JS SDK does not strip the body.
 * Callers MUST inspect `ok` (or back-compat `success`) to detect failure.
 */
function reply(payload: Record<string, unknown>) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function maskToken(t: string | undefined): string {
  if (!t) return "<empty>";
  return `len=${t.length} prefix=${t.slice(0, 6)}…`;
}

/**
 * Extract a relative storage object path from either a stored path
 * ("user-id/file.pdf") or a signed/public URL pointing at supabase storage.
 * Returns null if we can't safely identify a bucket-relative path.
 */
function extractStoragePath(value: string, bucket: string): string | null {
  if (!value) return null;
  if (!value.includes("://")) return value;
  const marker = `/storage/v1/object/`;
  const idx = value.indexOf(marker);
  if (idx === -1) return null;
  const after = value.slice(idx + marker.length);
  const parts = after.split("/");
  if (parts.length < 3) return null;
  if (parts[1] !== bucket) return null;
  const pathWithQuery = parts.slice(2).join("/");
  return pathWithQuery.split("?")[0];
}

// `admin` is intentionally typed as `any` here. The generated SupabaseClient
// generic shape recently became stricter (PostgrestVersion lock-down) and
// erroring on this internal helper is pure noise — purgeBucket only touches
// the storage API, which is identical across both shapes.
// deno-lint-ignore no-explicit-any
async function purgeBucket(
  admin: any,
  bucket: string,
  rawPaths: string[],
): Promise<{ requested: number; removed: number; errors: string[] }> {
  const errors: string[] = [];
  const paths = Array.from(
    new Set(
      rawPaths
        .map((p) => extractStoragePath(p, bucket))
        .filter((p): p is string => !!p),
    ),
  );
  if (paths.length === 0) return { requested: 0, removed: 0, errors };
  let removed = 0;
  for (let i = 0; i < paths.length; i += 500) {
    const chunk = paths.slice(i, i + 500);
    const { data, error } = await admin.storage.from(bucket).remove(chunk);
    if (error) {
      errors.push(`${bucket}: ${error.message}`);
    } else {
      removed += data?.length ?? 0;
    }
  }
  return { requested: paths.length, removed, errors };
}

/**
 * Purge every object in a bucket whose path starts with the tenant's
 * folder prefix (`<org_id>/…`). Used during platform-admin tenant delete
 * to wipe buckets whose paths aren't enumerated in tenant tables
 * (employee-documents, product-images, etc.). Walks the bucket in pages
 * of 1000 (storage.list default max) to avoid loading everything into
 * memory on large tenants.
 */
// deno-lint-ignore no-explicit-any
async function purgeBucketPrefix(
  admin: any,
  bucket: string,
  prefix: string,
): Promise<{ requested: number; removed: number; errors: string[] }> {
  const errors: string[] = [];
  let totalRequested = 0;
  let totalRemoved = 0;
  // List recursively by walking directory entries. Storage.list returns
  // files at the given prefix; subfolders come back as entries with no
  // metadata and id=null. We enqueue and drain.
  const queue: string[] = [prefix.replace(/\/$/, "")];
  const seen = new Set<string>();
  while (queue.length > 0) {
    const current = queue.shift()!;
    if (seen.has(current)) continue;
    seen.add(current);
    let offset = 0;
    // Hard cap to avoid runaway listing loops.
    for (let page = 0; page < 200; page++) {
      const { data, error } = await admin.storage
        .from(bucket)
        .list(current, { limit: 1000, offset });
      if (error) {
        errors.push(`${bucket}:list ${current}: ${error.message}`);
        break;
      }
      if (!data || data.length === 0) break;
      const files: string[] = [];
      for (const entry of data) {
        const full = current ? `${current}/${entry.name}` : entry.name;
        if (entry.id) {
          files.push(full);
        } else {
          queue.push(full);
        }
      }
      if (files.length > 0) {
        totalRequested += files.length;
        for (let i = 0; i < files.length; i += 500) {
          const chunk = files.slice(i, i + 500);
          const { data: rm, error: rmErr } = await admin.storage
            .from(bucket)
            .remove(chunk);
          if (rmErr) {
            errors.push(`${bucket}:remove: ${rmErr.message}`);
          } else {
            totalRemoved += rm?.length ?? 0;
          }
        }
      }
      if (data.length < 1000) break;
      offset += 1000;
    }
  }
  return { requested: totalRequested, removed: totalRemoved, errors };
}

// Storage purge is delegated to the shared runStorageGc helper, which
// uses the central convention registry (Phase 2 governance). Do NOT
// re-introduce a local TENANT_BUCKETS array here.

/**
 * Observability: persist an audit row per reset attempt to public.reset_runs.
 * Best-effort — failures here never block or fail the reset itself, they are
 * only logged. The row is written under service-role so RLS does not apply.
 */
// deno-lint-ignore no-explicit-any
async function startRun(admin: any, row: {
  organization_id: string | null;
  initiated_by: string | null;
  mode: string;
  categories?: string[] | null;
  trigger_source?: string | null;
}): Promise<{ id: string | null; startedAt: number }> {
  const startedAt = Date.now();
  try {
    const { data, error } = await admin
      .from("reset_runs")
      .insert({
        organization_id: row.organization_id,
        initiated_by: row.initiated_by,
        mode: row.mode,
        categories: row.categories ?? null,
        trigger_source: row.trigger_source ?? null,
        stage: "started",
      })
      .select("id")
      .single();
    if (error) {
      console.error("[clear-org-data] reset_runs insert failed:", error.message);
      return { id: null, startedAt };
    }
    return { id: data?.id ?? null, startedAt };
  } catch (e) {
    console.error("[clear-org-data] reset_runs insert threw:", e);
    return { id: null, startedAt };
  }
}

// deno-lint-ignore no-explicit-any
async function finishRun(admin: any, run: { id: string | null; startedAt: number }, patch: {
  ok: boolean;
  stage: string;
  error?: string | null;
  error_code?: string | null;
  error_hint?: string | null;
  counts?: unknown;
  storage_result?: unknown;
}) {
  if (!run.id) return;
  try {
    await admin
      .from("reset_runs")
      .update({
        ok: patch.ok,
        stage: patch.stage,
        error: patch.error ?? null,
        error_code: patch.error_code ?? null,
        error_hint: patch.error_hint ?? null,
        counts: patch.counts ?? null,
        storage_result: patch.storage_result ?? null,
        finished_at: new Date().toISOString(),
        duration_ms: Date.now() - run.startedAt,
      })
      .eq("id", run.id);
  } catch (e) {
    console.error("[clear-org-data] reset_runs update threw:", e);
  }
}


serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      console.error("[clear-org-data] missing authorization header");
      return reply({ ok: false, success: false, stage: "auth", error: "Missing authorization header" });
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseAnonKey = Deno.env.get("SUPABASE_ANON_KEY")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;

    const supabaseUser = createClient(supabaseUrl, supabaseAnonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const admin = createClient(supabaseUrl, supabaseServiceKey);

    // Detect service-role bearer (used by pg_cron). When present, we treat
    // the caller as platform-admin equivalent for the gc_orphans mode only.
    const bearer = authHeader.replace(/^Bearer\s+/i, "").trim();
    const isServiceRoleCaller = bearer === supabaseServiceKey;

    let user: { id: string } | null = null;
    if (!isServiceRoleCaller) {
      const { data, error: userError } = await supabaseUser.auth.getUser();
      if (userError || !data.user) {
        console.error("[clear-org-data] auth.getUser failed:", userError?.message);
        return reply({
          ok: false,
          success: false,
          stage: "auth",
          error: userError?.message || "Unauthorized",
        });
      }
      user = { id: data.user.id };
    }

    const body = (await req.json()) as ClearDataRequest;
    const { organization_id, categories, mode = "wipe_all", confirmation_token } = body;
    console.log(`[clear-org-data] user=${user?.id ?? "<service-role>"} org=${organization_id ?? "<none>"} mode=${mode}`);

    // ============================================================
    // GC_ORPHANS — platform-admin or service-role (pg_cron) only
    // ============================================================
    if (mode === "gc_orphans") {
      if (!isServiceRoleCaller) {
        const { data: isAdmin, error: adminErr } = await admin.rpc(
          "is_platform_admin",
          { _user_id: user!.id },
        );
        if (adminErr || !isAdmin) {
          return reply({
            ok: false,
            success: false,
            stage: "authorize",
            error: "gc_orphans requires platform admin",
          });
        }
      }
      const dryRun = body.dry_run !== false; // default TRUE for safety
      const run = await startRun(admin, {
        organization_id: null,
        initiated_by: user?.id ?? null,
        mode: "gc_orphans",
        trigger_source: isServiceRoleCaller
          ? "clear-org-data:gc_orphans:cron"
          : "clear-org-data:gc_orphans",
      });
      try {
        const gc = await runStorageGc(admin, {
          scope: "orphan",
          dryRun,
          triggeredBy: user?.id ?? null,
          triggerSource: isServiceRoleCaller
            ? "clear-org-data:gc_orphans:cron"
            : "clear-org-data:gc_orphans",
        });
        await finishRun(admin, run, { ok: true, stage: "complete", storage_result: gc });
        return reply({ ok: true, success: true, run_id: run.id, mode: "gc_orphans", dry_run: dryRun, result: gc });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        await finishRun(admin, run, { ok: false, stage: "gc_orphans", error: msg });
        return reply({
          ok: false,
          success: false,
          run_id: run.id,
          stage: "gc_orphans",
          error: msg,
        });
      }
    }


    // All other modes require an authenticated end user.
    if (!user) {
      return reply({ ok: false, success: false, stage: "auth", error: "Unauthorized" });
    }

    if (!organization_id) {
      return reply({ ok: false, success: false, stage: "validate", error: "Missing organization_id" });
    }

    // ============================================================
    // PREVIEW
    // ============================================================
    if (mode === "preview") {
      const { data, error } = await supabaseUser.rpc("preview_organization_reset", {
        org_id: organization_id,
      });
      if (error) {
        console.error("[clear-org-data] preview_organization_reset failed:", error);
        return reply({
          ok: false,
          success: false,
          stage: "preview",
          error: error.message,
          code: error.code,
          hint: error.hint ?? null,
          details: error.details ?? null,
        });
      }
      return reply({ ok: true, success: true, mode: "preview", ...data });
    }

    // ============================================================
    // WIPE_ALL
    // ============================================================
    if (mode === "wipe_all") {
      const expectedToken = `RESET-${organization_id}`;
      if (confirmation_token !== expectedToken) {
        console.error(
          `[clear-org-data] token mismatch: got ${maskToken(confirmation_token)} expected ${maskToken(expectedToken)}`,
        );
        return reply({
          ok: false,
          success: false,
          stage: "validate",
          error: "Invalid confirmation token",
          hint: `Expected RESET-<organization_id>. Received token does not match the org id in the request body.`,
        });
      }

      console.log("[clear-org-data] step 1: list_org_storage_paths");
      const { data: pathData, error: pathErr } = await supabaseUser.rpc(
        "list_org_storage_paths",
        { org_id: organization_id },
      );
      if (pathErr) {
        console.error("[clear-org-data] list_org_storage_paths failed:", pathErr);
        return reply({
          ok: false,
          success: false,
          stage: "list_storage_paths",
          error: pathErr.message,
          code: pathErr.code,
          hint: pathErr.hint ?? null,
          details: pathErr.details ?? null,
        });
      }
      const receiptPaths: string[] = pathData?.receipts ?? [];
      const docPdfPaths: string[] = pathData?.document_pdfs ?? [];
      console.log(
        `[clear-org-data] storage paths collected: receipts=${receiptPaths.length} document-pdfs=${docPdfPaths.length}`,
      );

      console.log("[clear-org-data] step 2: reset_organization_data");
      const { data, error } = await supabaseUser.rpc("reset_organization_data", {
        org_id: organization_id,
        confirmation_token: expectedToken,
      });
      if (error) {
        console.error("[clear-org-data] reset_organization_data failed:", error);
        return reply({
          ok: false,
          success: false,
          stage: "reset_organization_data",
          error: error.message,
          code: error.code,
          hint: error.hint ?? null,
          details: error.details ?? null,
        });
      }
      console.log("[clear-org-data] DB wipe completed:", JSON.stringify(data).slice(0, 500));

      console.log("[clear-org-data] step 3: storage purge");
      // Delegate to storage-gc — purges every bucket the convention
      // registry knows about for this org, not just receipts +
      // document-pdfs. Explicit-path purge of those two stays as a
      // belt-and-braces step for files whose storage rows were
      // recorded before Phase 1 trigger went live (already backfilled,
      // but keep the explicit pass for paths the resolver might miss
      // if a writer inserts without going through the trigger).
      const gcWipe = await runStorageGc(admin, {
        scope: "organization",
        id: organization_id,
        triggeredBy: user.id,
        triggerSource: "clear-org-data:wipe_all",
      });
      const storage = {
        gc: gcWipe,
        receipts_explicit: await purgeBucket(admin, "receipts", receiptPaths),
        "document-pdfs_explicit": await purgeBucket(admin, "document-pdfs", docPdfPaths),
      };

      try {
        await admin.from("audit_logs").insert({
          organization_id,
          user_id: user.id,
          action: "deleted",
          entity_type: "organization",
          entity_id: organization_id,
          entity_name: "Full Transactional Data Wipe",
          changes_summary: "Go-live wipe of all transactional data via clear-org-data",
          new_values: { db: data, storage },
        });
      } catch (e) {
        console.error("[clear-org-data] audit log failed:", e);
      }

      return reply({ ok: true, success: true, mode: "wipe_all", result: data, storage });
    }

    // ============================================================
    // DELETE_ORGANIZATION — platform-admin only full tenant removal
    // ============================================================
    if (mode === "delete_organization") {
      const expectedToken = `DELETE-${organization_id}`;
      if (confirmation_token !== expectedToken) {
        return reply({
          ok: false,
          success: false,
          stage: "validate",
          error: "Invalid confirmation token",
          hint: `Expected DELETE-<organization_id>. Received token does not match the org id in the request body.`,
        });
      }

      const { data: pathData, error: pathErr } = await supabaseUser.rpc(
        "list_org_storage_paths",
        { org_id: organization_id },
      );
      if (pathErr) {
        return reply({ ok: false, success: false, stage: "list_storage_paths", error: pathErr.message, code: pathErr.code });
      }

      const { data, error } = await supabaseUser.rpc("platform_delete_organization", {
        p_org_id: organization_id,
        p_confirmation_token: expectedToken,
      });
      if (error) {
        console.error("[clear-org-data] platform_delete_organization failed:", error);
        return reply({ ok: false, success: false, stage: "platform_delete_organization", error: error.message, code: error.code, hint: error.hint ?? null, details: error.details ?? null });
      }

      // Full tenant storage purge via the central garbage collector.
      const gcDel = await runStorageGc(admin, {
        scope: "organization",
        id: organization_id,
        triggeredBy: user.id,
        triggerSource: "clear-org-data:delete_organization",
      });
      const storage: Record<string, unknown> = { gc: gcDel };
      // Belt-and-braces: the two buckets whose paths SQL enumerates may
      // contain objects written before the Phase 1 trigger; do an
      // explicit-path pass for them too.
      storage.receipts_explicit = await purgeBucket(admin, "receipts", pathData?.receipts ?? []);
      storage["document-pdfs_explicit"] = await purgeBucket(admin, "document-pdfs", pathData?.document_pdfs ?? []);

      // ── Orphan-identity GC ─────────────────────────────────────────────
      // platform_delete_organization returns `orphan_member_user_ids` —
      // former members whose ONLY tenancy was the org we just deleted and
      // who are not platform admins. Reap their auth.users rows so the
      // email is freed for a fresh signup. Without this, the email is
      // permanently locked out (the devmuret@gmail.com bug).
      const orphanIds: string[] = Array.isArray((data as any)?.orphan_member_user_ids)
        ? ((data as any).orphan_member_user_ids as string[])
        : [];
      const reaped: { user_id: string; ok: boolean; error?: string }[] = [];
      for (const uid of orphanIds) {
        try {
          // deno-lint-ignore no-explicit-any
          const { error: delErr } = await (admin.auth.admin as any).deleteUser(uid);
          if (delErr) {
            console.error(`[clear-org-data] deleteUser ${uid} failed:`, delErr.message);
            reaped.push({ user_id: uid, ok: false, error: delErr.message });
          } else {
            reaped.push({ user_id: uid, ok: true });
          }
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          console.error(`[clear-org-data] deleteUser ${uid} threw:`, msg);
          reaped.push({ user_id: uid, ok: false, error: msg });
        }
      }

      return reply({
        ok: true,
        success: true,
        mode: "delete_organization",
        result: data,
        storage,
        identity_reap: { attempted: orphanIds.length, results: reaped },
      });
    }

    // ============================================================
    // CATEGORIES
    // ============================================================
    if (!categories || categories.length === 0) {
      return reply({
        ok: false,
        success: false,
        stage: "validate",
        error: "Missing categories",
      });
    }

    console.log(`[clear-org-data] reset_categories: ${categories.join(",")}`);
    const { data, error } = await supabaseUser.rpc("reset_categories", {
      org_id: organization_id,
      categories,
    });
    if (error) {
      console.error("[clear-org-data] reset_categories failed:", error);
      return reply({
        ok: false,
        success: false,
        stage: "reset_categories",
        error: error.message,
        code: error.code,
        hint: error.hint ?? null,
        details: error.details ?? null,
      });
    }

    try {
      await admin.from("audit_logs").insert({
        organization_id,
        user_id: user.id,
        action: "deleted",
        entity_type: "organization",
        entity_id: organization_id,
        entity_name: "Partial Data Wipe",
        changes_summary: `Cleared ${categories.length} module categories`,
        new_values: { categories, ...data },
      });
    } catch (e) {
      console.error("[clear-org-data] audit log failed:", e);
    }

    return reply({ ok: true, success: true, mode: "categories", result: data });
  } catch (error: unknown) {
    console.error("[clear-org-data] Unexpected error:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return reply({ ok: false, success: false, stage: "exception", error: message });
  }
});
