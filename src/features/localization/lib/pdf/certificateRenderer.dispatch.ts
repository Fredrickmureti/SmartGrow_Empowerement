/**
 * Browser-side dispatcher — mirrors the Deno
 * `supabase/functions/_shared/pdf/certificateRenderer.ts` fan-out.
 *
 * Templates with `body.schema_version >= 2` use the block-primitive
 * V2 renderer (`certificateRendererV2.ts`). Everything else falls
 * back to the legacy section renderer during the transition.
 */
import type { CertificatePayload, CertificateTemplate } from "./certificateRenderer";

export async function renderCertificatePdf(
  template: CertificateTemplate,
  payload: CertificatePayload,
): Promise<Uint8Array> {
  const schemaVersion = Number((template.body as any)?.schema_version ?? 1);
  if (schemaVersion >= 2) {
    const { renderCertificatePdfV2 } = await import("./certificateRendererV2");
    // The V2 renderer accepts a structurally-compatible template + payload.
    return renderCertificatePdfV2(template as any, payload as any);
  }
  const legacy = await import("./certificateRenderer");
  return legacy.renderCertificatePdf(template, payload);
}
