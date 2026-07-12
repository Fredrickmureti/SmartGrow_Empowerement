/**
 * hydrate-localization-binary-asset
 *
 * Enterprise ingest path for localization pack binary assets (e.g. KRA P9 /
 * P9A master workbooks). Once hydrated, the bytes live inline in
 * `localization_pack_binary_assets.bytes`, making every downstream renderer
 * (see generate-tax-certificate / generate-statutory-return) fully
 * deterministic and independent of any external CDN or storage origin.
 *
 * Contract:
 *   POST { asset_id: uuid,
 *          source: { bucket: string, path: string } | { base64: string } }
 *
 * Behaviour:
 *   1. Platform-admin auth required.
 *   2. Load target row from localization_pack_binary_assets.
 *   3. Read bytes from the staged Storage object or the inline base64.
 *   4. Compute SHA-256. If the row already has a `sha256`, it MUST match —
 *      the registry is content-addressable; a mismatch aborts with 409.
 *      If the row's sha256 is NULL, we populate it from the computed hash.
 *   5. Verify byte_size matches (when set on the row).
 *   6. Persist bytes + sha256 + byte_size in a single UPDATE.
 *   7. Best-effort delete of the staged Storage object.
 *
 * Never returns or logs the bytes.
 */

import { requirePlatformAdmin } from "../_shared/requirePlatformAdmin.ts";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

function hex(buf: ArrayBuffer): string {
  const bytes = new Uint8Array(buf);
  let out = "";
  for (let i = 0; i < bytes.length; i++) {
    out += bytes[i].toString(16).padStart(2, "0");
  }
  return out;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64.replace(/\s+/g, ""));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);

  let ctx;
  try {
    ctx = await requirePlatformAdmin(req);
  } catch (e) {
    if (e instanceof Response) return e;
    throw e;
  }
  const { admin } = ctx;

  let payload: any;
  try {
    payload = await req.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const assetId = payload?.asset_id;
  const source = payload?.source;
  if (typeof assetId !== "string" || !assetId) {
    return json({ error: "asset_id (uuid) is required" }, 400);
  }
  const hasStorage = source?.bucket && source?.path;
  const hasBase64 = typeof source?.base64 === "string" && source.base64.length > 0;
  if (!hasStorage && !hasBase64) {
    return json(
      { error: "source must be { bucket, path } or { base64 }" },
      400,
    );
  }

  // 1. Load registry row.
  const { data: row, error: loadErr } = await admin
    .from("localization_pack_binary_assets")
    .select("id, asset_key, sha256, byte_size")
    .eq("id", assetId)
    .maybeSingle();
  if (loadErr) return json({ error: `Registry lookup failed: ${loadErr.message}` }, 500);
  if (!row) return json({ error: `No binary asset with id ${assetId}` }, 404);

  // 2. Read bytes.
  let bytes: Uint8Array;
  if (hasStorage) {
    const { data, error } = await admin.storage.from(source.bucket).download(source.path);
    if (error || !data) {
      return json(
        { error: `Storage download failed for ${source.bucket}/${source.path}: ${error?.message ?? "no data"}` },
        400,
      );
    }
    bytes = new Uint8Array(await data.arrayBuffer());
  } else {
    try {
      bytes = base64ToBytes(source.base64);
    } catch {
      return json({ error: "Invalid base64 payload" }, 400);
    }
  }

  if (bytes.byteLength === 0) return json({ error: "Empty asset payload" }, 400);

  // 3. SHA-256 verification.
  const digest = hex(await crypto.subtle.digest("SHA-256", bytes));
  if (row.sha256 && row.sha256.toLowerCase() !== digest.toLowerCase()) {
    return json(
      {
        error: "SHA-256 mismatch: staged file does not match the registered hash",
        expected: row.sha256,
        actual: digest,
        asset_key: row.asset_key,
      },
      409,
    );
  }
  if (row.byte_size && Number(row.byte_size) !== bytes.byteLength) {
    return json(
      {
        error: "byte_size mismatch",
        expected: row.byte_size,
        actual: bytes.byteLength,
        asset_key: row.asset_key,
      },
      409,
    );
  }

  // 4. Persist. Postgres bytea over PostgREST accepts `\x…` hex.
  const bytea = "\\x" + hex(bytes.buffer);
  const { error: updateErr } = await admin
    .from("localization_pack_binary_assets")
    .update({
      bytes: bytea,
      sha256: digest,
      byte_size: bytes.byteLength,
      updated_at: new Date().toISOString(),
    })
    .eq("id", assetId);
  if (updateErr) {
    return json({ error: `Registry update failed: ${updateErr.message}` }, 500);
  }

  // 5. Best-effort cleanup of the staged object — do not fail the request.
  if (hasStorage) {
    await admin.storage.from(source.bucket).remove([source.path]).catch(() => {});
  }

  return json({
    ok: true,
    asset_id: assetId,
    asset_key: row.asset_key,
    sha256: digest,
    byte_size: bytes.byteLength,
  });
});
