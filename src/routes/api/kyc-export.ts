/**
 * Client KYC export endpoint.
 *
 * A raw HTTP route because the response is a binary ZIP. It is NOT under
 * `/api/public`: the caller must present the signed-in user's bearer token,
 * and every read inside the builder runs as that user so the existing
 * database access rules (RLS on `mf_clients` and the private `mf-kyc`
 * bucket) remain the only authorization boundary.
 */
import { createFileRoute } from "@tanstack/react-router";

import {
  buildKycExport,
  KycExportError,
  type KycExportRequest,
} from "@/lib/kyc/kycExport.server";

function bearer(request: Request): string | null {
  const header = request.headers.get("authorization") ?? "";
  const match = /^Bearer\s+(.+)$/i.exec(header.trim());
  return match?.[1]?.trim() || null;
}

function fail(message: string, status: number) {
  return new Response(JSON.stringify({ error: message }), {
    status,
    headers: { "content-type": "application/json; charset=utf-8" },
  });
}

export const Route = createFileRoute("/api/kyc-export")({
  server: {
    handlers: {
      POST: async ({ request }) => {
        const token = bearer(request);
        if (!token) return fail("You must be signed in to export KYC data", 401);

        let body: KycExportRequest;
        try {
          body = (await request.json()) as KycExportRequest;
        } catch {
          return fail("Invalid export request", 400);
        }
        if (body?.mode !== "single" && body?.mode !== "bulk") {
          return fail("Invalid export request", 400);
        }

        try {
          const result = await buildKycExport(token, {
            mode: body.mode,
            ...(body.clientId ? { clientId: body.clientId } : {}),
            ...(body.businessId ? { businessId: body.businessId } : {}),
            branchId: body.branchId ?? null,
            status: body.status ?? null,
            clientIds: Array.isArray(body.clientIds) ? body.clientIds : null,
          });

          return new Response(result.bytes as unknown as BodyInit, {
            status: 200,
            headers: {
              "content-type": "application/zip",
              "content-disposition": `attachment; filename="${result.filename}"`,
              "cache-control": "no-store",
              "x-kyc-export-summary": encodeURIComponent(JSON.stringify(result.summary)),
            },
          });
        } catch (error) {
          if (error instanceof KycExportError) return fail(error.message, error.status);
          console.error("[kyc-export]", error);
          return fail("The KYC export could not be completed", 500);
        }
      },
    },
  },
});
