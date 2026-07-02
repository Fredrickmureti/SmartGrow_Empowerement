// Shared storage garbage collector. Single source of truth for all
// tenant/user/orphan storage deletion. Both `clear-org-data` and
// `platform-delete-user` import this and invoke it directly with their
// existing service-role admin client — no extra edge-function HTTP hop.
//
// Behavior:
//  1. Call public.storage_gc_resolve_objects(scope, id) to get
//     (bucket, name) pairs from the convention-driven ownership index.
//  2. Group by bucket; remove in batches of 100.
//  3. INSERT a `storage_gc_runs` audit row.
//  4. The DELETE trigger on storage.objects clears ownership rows.

// deno-lint-ignore-file no-explicit-any

export type StorageGcScope = "organization" | "user" | "entity" | "orphan";

export interface StorageGcInput {
  scope: StorageGcScope;
  id?: string;
  dryRun?: boolean;
  triggerSource?: string;
  triggeredBy?: string | null;
}

export interface StorageGcResult {
  ok: boolean;
  scope: StorageGcScope;
  id: string | null;
  dry_run: boolean;
  objects_resolved: number;
  objects_removed: number;
  per_bucket: Record<string, { resolved: number; removed: number; errors: string[] }>;
  errors: { bucket: string; message: string }[];
  started_at: string;
  finished_at: string;
  stage?: string;
  error?: string;
}

interface ResolvedRow {
  bucket_id: string;
  object_name: string;
}

const BATCH = 100;

export async function runStorageGc(
  admin: any,
  input: StorageGcInput,
): Promise<StorageGcResult> {
  const startedAt = new Date().toISOString();
  const { scope, id, dryRun = false, triggerSource = "manual", triggeredBy = null } = input;

  const baseResult: StorageGcResult = {
    ok: false,
    scope,
    id: id ?? null,
    dry_run: dryRun,
    objects_resolved: 0,
    objects_removed: 0,
    per_bucket: {},
    errors: [],
    started_at: startedAt,
    finished_at: startedAt,
  };

  if (!["organization", "user", "entity", "orphan"].includes(scope)) {
    return { ...baseResult, stage: "validate", error: `Invalid scope: ${scope}` };
  }
  if (scope !== "orphan" && !id) {
    return { ...baseResult, stage: "validate", error: "id is required for non-orphan scopes" };
  }

  const { data: rows, error: resolveErr } = await admin.rpc(
    "storage_gc_resolve_objects",
    { p_scope: scope, p_target_id: id ?? null },
  );
  if (resolveErr) {
    console.error("[storage-gc] resolve failed:", resolveErr);
    return {
      ...baseResult,
      stage: "resolve",
      error: resolveErr.message,
      finished_at: new Date().toISOString(),
    };
  }

  const resolved = (rows ?? []) as ResolvedRow[];
  const byBucket = new Map<string, string[]>();
  for (const r of resolved) {
    const list = byBucket.get(r.bucket_id) ?? [];
    list.push(r.object_name);
    byBucket.set(r.bucket_id, list);
  }

  const perBucket: Record<string, { resolved: number; removed: number; errors: string[] }> = {};
  const errors: { bucket: string; message: string }[] = [];
  let totalRemoved = 0;

  if (!dryRun) {
    for (const [bucket, names] of byBucket.entries()) {
      const stat = { resolved: names.length, removed: 0, errors: [] as string[] };
      for (let i = 0; i < names.length; i += BATCH) {
        const chunk = names.slice(i, i + BATCH);
        const { data: rm, error: rmErr } = await admin.storage.from(bucket).remove(chunk);
        if (rmErr) {
          stat.errors.push(rmErr.message);
          errors.push({ bucket, message: rmErr.message });
        } else {
          stat.removed += rm?.length ?? 0;
          totalRemoved += rm?.length ?? 0;
        }
      }
      perBucket[bucket] = stat;
    }
  } else {
    for (const [bucket, names] of byBucket.entries()) {
      perBucket[bucket] = { resolved: names.length, removed: 0, errors: [] };
    }
  }

  const finishedAt = new Date().toISOString();

  try {
    await admin.from("storage_gc_runs").insert({
      scope,
      target_id: id ?? null,
      dry_run: dryRun,
      objects_resolved: resolved.length,
      objects_removed: totalRemoved,
      bytes_freed: 0,
      per_bucket: perBucket,
      errors,
      triggered_by: triggeredBy ?? null,
      trigger_source: triggerSource,
      started_at: startedAt,
      finished_at: finishedAt,
    });
  } catch (e) {
    console.error("[storage-gc] audit insert failed:", e);
  }

  return {
    ok: true,
    scope,
    id: id ?? null,
    dry_run: dryRun,
    objects_resolved: resolved.length,
    objects_removed: totalRemoved,
    per_bucket: perBucket,
    errors,
    started_at: startedAt,
    finished_at: finishedAt,
  };
}