/**
 * etims-transmit — unified KRA eTIMS dispatcher.
 *
 * Body: either
 *   { action: "init" | "register_item" | "sync_codes", ...payload }
 * or (legacy transmit):
 *   { doc_type: "invoice" | "credit_note" | "pos", ...payload }
 *
 * Routes to handler bodies preserved verbatim under `_shared/etims/*.ts`.
 */
import { handle as handleInvoice } from "../_shared/etims/invoice.ts";
import { handle as handleCreditNote } from "../_shared/etims/creditNote.ts";
import { handle as handlePos } from "../_shared/etims/pos.ts";
import { handle as handleInit } from "../_shared/etims/init.ts";
import { handle as handleRegisterItem } from "../_shared/etims/registerItem.ts";
import { handle as handleSyncCodes } from "../_shared/etims/syncCodes.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  let body: Record<string, unknown> = {};
  try { body = await req.json(); } catch { /* allow empty */ }

  const proxied = () => new Request(req.url, {
    method: req.method,
    headers: req.headers,
    body: JSON.stringify(body),
  });

  const action = body.action ? String(body.action) : null;
  if (action === "init") return handleInit(proxied());
  if (action === "register_item") return handleRegisterItem(proxied());
  if (action === "sync_codes") return handleSyncCodes(proxied());

  const docType = String(body.doc_type ?? "invoice");
  if (docType === "invoice") return handleInvoice(proxied());
  if (docType === "credit_note") return handleCreditNote(proxied());
  if (docType === "pos") return handlePos(proxied());

  return new Response(
    JSON.stringify({ success: false, error: `Unknown action/doc_type` }),
    { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
});
