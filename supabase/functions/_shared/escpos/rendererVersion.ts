/**
 * Canonical ESC/POS renderer identity. Bump `RENDERER_VERSION` whenever
 * the shared engine's output changes in a way that would invalidate
 * checked-in goldens or persisted artifacts.
 *
 * Emitted on every ESC/POS response as `X-Renderer: <name>@<version>`
 * and recorded in `receipt_render_log.renderer` / `.renderer_version`.
 * A single grep across the edge-function logs answers "which pipeline
 * produced this receipt" without ambiguity.
 */

export const RENDERER_NAME = "shared-engine";
export const RENDERER_VERSION = "6b.4";
export const RENDERER_ID = `${RENDERER_NAME}@${RENDERER_VERSION}`;

/** Hex SHA-256 of the given bytes (used for wire-path fingerprinting). */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  const view = new Uint8Array(digest);
  let out = "";
  for (const b of view) out += b.toString(16).padStart(2, "0");
  return out;
}
