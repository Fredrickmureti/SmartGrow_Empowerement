/**
 * localization-pack — router Edge Function
 *
 * Consolidates nine legacy per-operation localization functions into a
 * single deployment slot while keeping the internal implementation
 * modular. Each operation lives in `./ops/<op>.ts` and exports a
 * `run(req)` handler that is byte-compatible with its former standalone
 * function — same request body shape, same response envelope, same auth
 * gates, same error semantics.
 *
 * Contract:
 *   POST /functions/v1/localization-pack
 *   Body: { op: <operation-name>, ...originalPayload }
 *
 * The `op` field is the ONLY new requirement. Every other field is
 * forwarded to the underlying operation exactly as the legacy function
 * received it.
 */
import { run as runInstall } from "./ops/install.ts";
import { run as runApplyUpgrade } from "./ops/apply-upgrade.ts";
import { run as runRollbackUpgrade } from "./ops/rollback-upgrade.ts";
import { run as runValidatePayload } from "./ops/validate-payload.ts";
import { run as runLint } from "./ops/lint.ts";
import { run as runPublishVersion } from "./ops/publish-version.ts";
import { run as runPromoteVersion } from "./ops/promote-version.ts";
import { run as runProposeUpgrades } from "./ops/propose-upgrades.ts";
import { run as runProcessOutbox } from "./ops/process-outbox.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
};

type OpHandler = (req: Request) => Promise<Response>;

/**
 * Registry maps the legacy function name AND a short alias to the same
 * handler. Frontend callers pass the legacy name (`op: "install-localization-pack"`)
 * so grepping for the old identifiers still surfaces every call site.
 */
const OPS: Record<string, OpHandler> = {
  // legacy names (primary — used by client callers)
  "install-localization-pack": runInstall,
  "apply-localization-pack-upgrade": runApplyUpgrade,
  "rollback-localization-pack-upgrade": runRollbackUpgrade,
  "validate-localization-payload": runValidatePayload,
  "lint-localization-pack": runLint,
  "publish-localization-pack-version": runPublishVersion,
  "promote-pack-version": runPromoteVersion,
  "propose-localization-upgrades": runProposeUpgrades,
  "process-localization-outbox": runProcessOutbox,
  // short aliases
  install: runInstall,
  "apply-upgrade": runApplyUpgrade,
  "rollback-upgrade": runRollbackUpgrade,
  "validate-payload": runValidatePayload,
  lint: runLint,
  "publish-version": runPublishVersion,
  "promote-version": runPromoteVersion,
  "propose-upgrades": runProposeUpgrades,
  "process-outbox": runProcessOutbox,
};

function jsonError(code: string, message: string, status: number) {
  return new Response(
    JSON.stringify({ error: message, code }),
    { status, headers: { ...corsHeaders, "Content-Type": "application/json" } },
  );
}

/**
 * Wrap the incoming Request so op handlers that call `req.json()` see
 * the already-parsed body (the router had to parse it to read `op`).
 * Everything else — headers, method, url — pointer-forwards to the
 * original Request untouched, preserving Authorization / apikey / CORS
 * behaviour that each op relies on.
 */
function withParsedBody(req: Request, body: unknown): Request {
  return new Proxy(req, {
    get(target, prop, receiver) {
      if (prop === "json") return async () => body;
      if (prop === "text") return async () => JSON.stringify(body);
      const v = Reflect.get(target, prop, receiver);
      return typeof v === "function" ? v.bind(target) : v;
    },
  }) as Request;
}

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }
  if (req.method !== "POST") {
    return jsonError("BAD_REQUEST", "Method not allowed", 405);
  }

  let raw: any;
  try {
    raw = await req.json();
  } catch {
    return jsonError("BAD_REQUEST", "Invalid JSON body", 400);
  }
  if (!raw || typeof raw !== "object") {
    return jsonError("BAD_REQUEST", "Body must be a JSON object with an `op` field", 400);
  }

  const op = String(raw.op ?? "").trim();
  if (!op) {
    return jsonError("BAD_REQUEST", "`op` is required", 400);
  }

  const handler = OPS[op];
  if (!handler) {
    return jsonError(
      "BAD_REQUEST",
      `Unknown op "${op}". Valid ops: ${Object.keys(OPS).filter((k) => k.includes("-")).join(", ")}`,
      400,
    );
  }

  // Strip `op` from the forwarded body so downstream `const { ... } = await req.json()`
  // destructuring sees the exact payload shape it saw as a standalone function.
  const { op: _omit, ...payload } = raw;
  const proxied = withParsedBody(req, payload);

  try {
    return await handler(proxied);
  } catch (e) {
    console.error(`[localization-pack] uncaught in op "${op}"`, e);
    return jsonError("INTERNAL", (e as any)?.message ?? String(e), 500);
  }
});
