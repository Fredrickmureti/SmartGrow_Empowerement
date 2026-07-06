/**
 * publish-localization-pack-version
 *
 * Snapshots the current state of all pack-related rows into an immutable
 * `pack_versions` row, generates a JSON changelog vs the prior published
 * version, and fan-outs `pack_upgrade_proposals` for tenants pinned to
 * the previous version.
 *
 * Round-2 hardening (Phase 1 + 2 of the localization architecture plan):
 *   - Typed auth gate via `_shared/localizationAuth.ts` so failures are
 *     legible (`AUTH_MISSING_HEADER` / `AUTH_INVALID_TOKEN` /
 *     `AUTH_NOT_PLATFORM_ADMIN`) instead of an opaque "401 Unauthorized".
 *   - Hard `lint` gate before snapshotting (calls the SAME RPC the
 *     dedicated lint function uses, server-side, so broken packs cannot
 *     ship).
 *   - Strict semver + monotonicity check vs the previous published
 *     version.
 *   - Content-hash idempotency: republishing the same content with the
 *     same version is a no-op; the same content with a new version is
 *     accepted but flagged as `noop_content` in the changelog.
 *   - Deduped proposal fan-out (relies on the new
 *     `pack_upgrade_proposals_target_uk` constraint).
 *
 * Body: { pack_id: uuid, version: string, notes?: string, propose_upgrades?: boolean, skip_lint?: boolean }
 * Returns: { version_id, version, changelog, content_hash, proposals_created }
 */
import {
  errorResponse,
  jsonResponse,
  localizationCorsHeaders,
  requirePackPublisher,
} from "../_shared/localizationAuth.ts";
import { compareSemver, isValidSemver } from "../_shared/semver.ts";
import { hashSnapshot } from "../_shared/canonicalize.ts";
import { validateAgainstSchema } from "../_shared/validateAgainstSchema.ts";

const PACK_TABLES = [
  "localization_pack_payroll_templates",
  "localization_pack_account_templates",
  "localization_pack_tax_templates",
  "localization_pack_certificate_templates",
  "localization_pack_return_templates",
  "localization_pack_remittance_schedules",
  "localization_pack_work_entry_type_templates",
  "pack_token_registry",
] as const;

// Rule-type schemas are not pack-scoped, but a pack version must
// snapshot the schemas that were live at publish time so tenants can
// reproduce the exact validation rules that graded the pack's contents
// (ADR 0060). Cached under a synthetic `_schemas` key in the snapshot.
const SNAPSHOT_GLOBAL_TABLES = [
  "pack_rule_type_schemas",
] as const;

/** Naive deep diff producing JSON-pointer-ish paths. */
function diff(a: any, b: any, path = ""): Record<string, { from: any; to: any }> {
  const out: Record<string, { from: any; to: any }> = {};
  if (a === b) return out;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) {
    out[path || "$"] = { from: a, to: b };
    return out;
  }
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    const sub = diff(a?.[k], b?.[k], path ? `${path}.${k}` : k);
    Object.assign(out, sub);
  }
  return out;
}

async function snapshotPack(sb: any, packId: string) {
  const snap: Record<string, any[]> = {};
  for (const t of PACK_TABLES) {
    const { data, error } = await sb.from(t).select("*").eq("pack_id", packId);
    if (error) throw new Error(`${t}: ${error.message}`);
    snap[t] = data ?? [];
  }
  // Global tables (rule-type schemas) — snapshot at publish time so a
  // pack version carries the exact validation rules that graded it.
  for (const t of SNAPSHOT_GLOBAL_TABLES) {
    const { data, error } = await sb.from(t).select("*");
    if (error) throw new Error(`${t}: ${error.message}`);
    snap[t] = data ?? [];
  }
  const { data: pack } = await sb.from("localization_packs").select("*").eq("id", packId).single();
  snap["_pack"] = [pack];
  return snap;
}

/**
 * Server-side lint gate. Validates every pack payroll template AND
 * every certificate template against their registered JSON Schemas,
 * plus certificate legal-metadata completeness (ADR 0060). Empty means
 * clean.
 */
async function lintPack(sb: any, packId: string): Promise<string[]> {
  const errors: string[] = [];

  const { data: rules } = await sb
    .from("localization_pack_payroll_templates")
    .select("id, rule_name, rule_type, parameters")
    .eq("pack_id", packId);

  const { data: schemas } = await sb
    .from("pack_rule_type_schemas")
    .select("rule_type, computation_kind, schema_version, json_schema");

  // Highest schema per (rule_type, computation_kind)
  const schemaByKey = new Map<string, any>();
  for (const s of schemas ?? []) {
    const key = `${s.rule_type}::${s.computation_kind}`;
    const cur = schemaByKey.get(key);
    if (!cur || cur.schema_version < s.schema_version) schemaByKey.set(key, s);
  }

  for (const r of rules ?? []) {
    const kind = r.parameters?.type ?? "unknown";
    const schema = schemaByKey.get(`${r.rule_type}::${kind}`);
    if (!schema) {
      errors.push(`${r.rule_name}: no JSON Schema registered for ${r.rule_type}/${kind}`);
      continue;
    }
    const e = validateAgainstSchema(r.parameters, schema.json_schema);
    for (const m of e) errors.push(`${r.rule_name}: ${m}`);
  }

  // ADR 0060 — certificate templates must carry legal metadata and
  // pass the certificate_template_v2 schema. Legacy pre-v2 bodies
  // (legacy_unvalidated=true) MUST be migrated before publish.
  const { data: certs } = await sb
    .from("localization_pack_certificate_templates")
    .select("code, display_name, body, authority_id, legal_reference, effective_date, legacy_unvalidated")
    .eq("pack_id", packId);
  const certSchema = schemaByKey.get("certificate_template::v2");
  for (const c of certs ?? []) {
    const label = c.display_name || c.code;
    if (!c.authority_id) errors.push(`${label}: missing statutory authority`);
    if (!c.legal_reference) errors.push(`${label}: missing legal reference`);
    if (!c.effective_date) errors.push(`${label}: missing effective date`);
    if (c.legacy_unvalidated) {
      errors.push(`${label}: legacy pre-v2 body — re-save in the editor to adopt certificate_template_v2 sections`);
      continue;
    }
    if (certSchema) {
      const e = validateAgainstSchema(c.body, certSchema.json_schema);
      for (const m of e) errors.push(`${label}: ${m}`);
    }
  }

  return errors;
}

/** Highest schema_version referenced by any rule in the pack. */
async function maxSchemaVersion(sb: any, packId: string): Promise<number> {
  const { data: rules } = await sb
    .from("localization_pack_payroll_templates")
    .select("rule_type, parameters")
    .eq("pack_id", packId);
  if (!rules?.length) return 1;
  const keys = new Set(rules.map((r: any) => `${r.rule_type}::${r.parameters?.type ?? "unknown"}`));
  const { data: schemas } = await sb
    .from("pack_rule_type_schemas")
    .select("rule_type, computation_kind, schema_version");
  let max = 1;
  for (const s of schemas ?? []) {
    if (keys.has(`${s.rule_type}::${s.computation_kind}`)) {
      if (s.schema_version > max) max = s.schema_version;
    }
  }
  return max;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: localizationCorsHeaders });
  try {
    const body = await req.json().catch(() => ({}));
    const { pack_id, version, notes, propose_upgrades = true, skip_lint = false } = body ?? {};

    if (!pack_id || !version) {
      return errorResponse("BAD_REQUEST", "pack_id and version are required", 400);
    }

    // Phase 5: pack publisher OR platform admin can publish. The helper
    // resolves to is_pack_publisher() which accepts both.
    const gate = await requirePackPublisher(req, pack_id);
    if (!gate.ok) return gate.response;
    const { auth: { user, serviceClient: sb } } = gate;

    if (!isValidSemver(version)) {
      return errorResponse(
        "BAD_REQUEST",
        `Version "${version}" is not valid semver (expected MAJOR.MINOR.PATCH[-prerelease]).`,
        400,
      );
    }

    // skip_lint is a privileged escape hatch — only platform admins may
    // ship a pack that has not passed the cross-row lint gate. Publishers
    // (partner-level) must always pass lint.
    if (skip_lint) {
      const { data: isAdmin } = await sb
        .rpc("is_platform_admin", { _user_id: user.id })
        .single();
      if (!isAdmin) {
        return errorResponse(
          "AUTH_NOT_PLATFORM_ADMIN",
          "skip_lint is reserved for platform admins. Resolve the lint issues and republish.",
          403,
        );
      }
    }

    // Lint gate — never let a broken pack ship.
    if (!skip_lint) {
      const lintErrors = await lintPack(sb, pack_id);
      if (lintErrors.length > 0) {
        return errorResponse(
          "LINT_FAILED",
          `Pack failed lint with ${lintErrors.length} issue(s). Resolve them before publishing or pass skip_lint:true (not recommended).`,
          422,
          { lint_errors: lintErrors.slice(0, 50) },
        );
      }
    }

    // Previous published version (if any) for diff + monotonicity check.
    const { data: prev } = await sb
      .from("pack_versions")
      .select("id, version, snapshot, content_hash")
      .eq("pack_id", pack_id)
      .eq("status", "published")
      .order("published_at", { ascending: false })
      .limit(1)
      .maybeSingle();

    if (prev) {
      try {
        if (compareSemver(version, prev.version) <= 0) {
          return errorResponse(
            "BAD_REQUEST",
            `Version ${version} must be strictly greater than the previously published ${prev.version}.`,
            400,
          );
        }
      } catch (e: any) {
        return errorResponse("BAD_REQUEST", e?.message ?? "semver comparison failed", 400);
      }
    }

    const snapshot = await snapshotPack(sb, pack_id);
    const content_hash = await hashSnapshot(snapshot);
    const schema_version = await maxSchemaVersion(sb, pack_id);

    // Idempotency: republishing the same content under any version is a
    // no-op proposal-wise. We still record the new pack_versions row
    // (publishers occasionally need a fresh version label for an audit
    // trail even when the content is byte-identical) but the changelog
    // is marked accordingly.
    const noopContent = prev?.content_hash === content_hash;

    const changelog: Record<string, any> = {
      from: prev?.version ?? null,
      to: version,
      tables: {},
      noop_content: noopContent,
      notes: notes ?? null,
    };

    if (prev && !noopContent) {
      for (const t of PACK_TABLES) {
        const before = (prev.snapshot?.[t] ?? []) as any[];
        const after = (snapshot[t] ?? []) as any[];
        const beforeById = new Map(before.map((r) => [r.id, r]));
        const afterById = new Map(after.map((r) => [r.id, r]));
        const changes: any[] = [];
        for (const [id, row] of afterById) {
          if (!beforeById.has(id)) changes.push({ id, kind: "added", row });
          else {
            const d = diff(beforeById.get(id), row);
            if (Object.keys(d).length) changes.push({ id, kind: "modified", fields: d });
          }
        }
        for (const id of beforeById.keys()) {
          if (!afterById.has(id)) changes.push({ id, kind: "removed", row: beforeById.get(id) });
        }
        if (changes.length) changelog.tables[t] = changes;
      }
    } else if (!prev) {
      changelog.initial = true;
    }

    const { data: inserted, error: insErr } = await sb
      .from("pack_versions")
      .insert({
        pack_id,
        version,
        status: "published",
        changelog,
        snapshot,
        content_hash,
        schema_version,
        published_at: new Date().toISOString(),
        published_by: user.id,
        created_by: user.id,
        parent_version_id: prev?.id ?? null,
      })
      .select("id, version, content_hash")
      .single();
    if (insErr) {
      // Duplicate (pack_id, version) → CONFLICT, not 500.
      if ((insErr as any).code === "23505") {
        return errorResponse("CONFLICT", `Version ${version} already exists for this pack.`, 409);
      }
      return errorResponse("INTERNAL", insErr.message, 500);
    }

    // Fan-out proposals — guarded by the new UNIQUE constraint so
    // re-publishing the same version is idempotent at the proposal layer.
    let proposals_created = 0;
    if (propose_upgrades && prev && !noopContent) {
      const { data: installs } = await sb
        .from("installed_localization_packs")
        .select("organization_id, business_id, pack_version")
        .eq("pack_id", pack_id);
      for (const inst of installs ?? []) {
        if (inst.pack_version === version) continue;
        const { error: pErr } = await sb.from("pack_upgrade_proposals").insert({
          organization_id: inst.organization_id,
          business_id: inst.business_id,
          pack_id,
          from_version: inst.pack_version ?? prev.version,
          to_version: version,
          diff: changelog,
          status: "pending",
        });
        if (!pErr) proposals_created++;
        // 23505 = duplicate proposal for (org, business, pack, to_version)
        // → silently ignore: tenant already knows about this version.
        else if ((pErr as any).code !== "23505") {
          console.warn("[publish] proposal insert failed", pErr.message);
        }
      }
    }

    return jsonResponse({
      version_id: inserted.id,
      version: inserted.version,
      content_hash: inserted.content_hash,
      changelog,
      proposals_created,
      noop_content: noopContent,
    });
  } catch (e: any) {
    return errorResponse("INTERNAL", e?.message ?? String(e), 500);
  }
});
