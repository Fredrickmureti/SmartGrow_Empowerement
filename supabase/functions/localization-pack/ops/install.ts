/**
 * install-localization-pack (Phase 5 — thin wrapper)
 *
 * Delegates the actual pack install to the SQL RPC
 * `install_localization_pack_atomic`, which seeds taxes, accounts, and
 * payroll statutory rules inside a single transaction. This function only:
 *   1. authenticates the caller (with distinct error codes for each
 *      failure mode so the frontend and logs can tell us *why* a 401
 *      happened),
 *   2. resolves `business_id` / `pack_id` (accepting `country_code` for
 *      back-compat),
 *   3. calls the RPC,
 *   4. runs the post-install GL auto-mapping (kept here because it needs
 *      to call multiple RPCs and is not part of the atomic install).
 */
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.49.1";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type, x-supabase-client-platform, x-supabase-client-platform-version, x-supabase-client-runtime, x-supabase-client-runtime-version",
};

type ErrorCode =
  | "AUTH_MISSING_HEADER"
  | "AUTH_INVALID_TOKEN"
  | "AUTH_NO_ROLE_FOR_ORG"
  | "BAD_REQUEST"
  | "NOT_FOUND"
  | "LOOKUP_FAILED"
  | "INSTALL_FAILED"
  | "INSTALL_SCHEMA_DRIFT"
  | "INSTALL_DUPLICATE"
  | "INSTALL_INVALID_DATA"
  | "INSTALL_CHECK_VIOLATION"
  | "PAYROLL_NOT_INSTALLED"
  | "APP_NOT_INSTALLED"
  | "ENTITLEMENT_REQUIRED"
  | "INSTALL_PRECONDITION_FAILED"
  | "INTERNAL";

function reply(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

function err(code: ErrorCode, message: string, status: number, ctx: Record<string, unknown> = {}) {
  // Structured log so distinct failure modes can be told apart from the
  // edge-function log stream.
  console.error(`[install-localization-pack] ${code}: ${message}`, ctx);
  return reply({ error: message, code, ...ctx }, status);
}

/**
 * Map a Postgres SQLSTATE coming back from
 * `install_localization_pack_atomic` to a UI-friendly error code.
 *
 * The RPC now re-raises with the original SQLSTATE and a HINT containing
 * the failing step name, so we can produce a precise diagnostic instead
 * of a generic 500. Anything we don't explicitly handle falls back to
 * INSTALL_FAILED with the raw pg message preserved for the logs.
 */
function classifyInstallError(pgErr: { code?: string; message?: string; details?: string; hint?: string }): {
  code: ErrorCode;
  status: number;
  userMessage: string;
} {
  const sqlstate = pgErr.code ?? "";
  const step = pgErr.hint ?? "unknown";
  const raw = pgErr.message ?? "Unknown install failure";

  switch (sqlstate) {
    case "23502": // not_null_violation
      return {
        code: "INSTALL_SCHEMA_DRIFT",
        status: 500,
        userMessage:
          `Pack install failed at step "${step}" because a required column was missing. ` +
          `This is a schema-drift bug; please report this with the step name.`,
      };
    case "22P02": // invalid_text_representation (bad enum cast)
      return {
        code: "INSTALL_INVALID_DATA",
        status: 500,
        userMessage:
          `Pack install failed at step "${step}" because the pack contains a value ` +
          `not accepted by the runtime schema (e.g. an unknown account type).`,
      };
    case "23505": // unique_violation
      return {
        code: "INSTALL_DUPLICATE",
        status: 409,
        userMessage:
          `Pack install failed at step "${step}" because of a duplicate record. ` +
          `Use force_reseed=true if you intend to overwrite, or clean up the existing rows first.`,
      };
    case "P0002": // no_data_found (our RAISE in the RPC)
      return {
        code: "NOT_FOUND",
        status: 404,
        userMessage: raw,
      };
    case "23514": { // check_violation, e.g. accounts_is_system_requires_role
      // Surface the specific check constraint when present.
      const constraint = /constraint "([^"]+)"/.exec(raw)?.[1];
      const constraintHint = constraint ? ` (constraint: ${constraint})` : "";
      return {
        code: "INSTALL_CHECK_VIOLATION",
        status: 500,
        userMessage:
          `Pack install failed at step "${step}" because a database integrity check was violated${constraintHint}. ` +
          `This usually means the pack template tried to create a row that did not satisfy a structural rule ` +
          `(for example, a system-owned account without a system role). Please report this with the step name.`,
      };
    }
    case "P0001": { // raise_exception — our own RAISE without ERRCODE
      // Detect common app-gate failures coming from
      // assert_app_installed_for_write('payroll') and similar.
      const m = /APP_NOT_INSTALLED:?\s*([a-z0-9_\-]+)?/i.exec(raw);
      if (m) {
        const app = (m[1] ?? "").toLowerCase();
        if (app === "payroll" || step.toLowerCase().includes("payroll") || raw.toLowerCase().includes("payroll")) {
          return {
            code: "PAYROLL_NOT_INSTALLED",
            status: 409,
            userMessage:
              `Pack install failed at step "${step}" because the Payroll app is not installed for this business. ` +
              `Install Payroll first, then re-run the localization pack install.`,
          };
        }
        return {
          code: "APP_NOT_INSTALLED",
          status: 409,
          userMessage:
            `Pack install failed at step "${step}" because the required app "${app || "unknown"}" is not installed for this business. ` +
            `Install the app first, then re-run the localization pack install.`,
        };
      }
      if (/entitlement|not entitled|subscription/i.test(raw)) {
        return {
          code: "ENTITLEMENT_REQUIRED",
          status: 402,
          userMessage:
            `Pack install failed at step "${step}" because the workspace is not entitled to this feature. ` +
            `Upgrade or enable the required subscription, then retry.`,
        };
      }
      // Generic precondition / business-rule failure.
      return {
        code: "INSTALL_PRECONDITION_FAILED",
        status: 409,
        userMessage:
          `Pack install failed at step "${step}": ${raw}`,
      };
    }
    default:
      return {
        code: "INSTALL_FAILED",
        status: 500,
        userMessage: raw,
      };
  }
}

export async function run(req: Request): Promise<Response> {

  if (req.method === "OPTIONS") return new Response(null, { headers: corsHeaders });

  try {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return err("AUTH_MISSING_HEADER", "Missing authorization header", 401);
    }

    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    const anonKey = Deno.env.get("SUPABASE_ANON_KEY")!;

    const userClient = createClient(supabaseUrl, anonKey, {
      global: { headers: { Authorization: authHeader } },
    });
    const { data: { user }, error: authErr } = await userClient.auth.getUser();
    if (authErr || !user) {
      return err(
        "AUTH_INVALID_TOKEN",
        "Could not validate session token. Please sign in again.",
        401,
        { authErr: authErr?.message },
      );
    }

    const admin = createClient(supabaseUrl, serviceKey);

    const { organization_id, business_id, pack_id, country_code, auto_install, force_reseed, acknowledge_skeleton } =
      await req.json();

    console.log("[install-localization-pack] entry", {
      user_id: user.id,
      business_id,
      pack_id,
      country_code,
      auto_install: !!auto_install,
      force_reseed: !!force_reseed,
    });

    if (!business_id) {
      return err(
        "BAD_REQUEST",
        "business_id is required (localization is per-Company)",
        400,
        { user_id: user.id },
      );
    }

    // Verify business + org membership.
    // Use maybeSingle() so a missing row is data=null, not a thrown error;
    // surface PostgREST errors as LOOKUP_FAILED instead of silently treating
    // them as "not found".
    const { data: business, error: businessErr } = await admin
      .from("businesses")
      .select("id, organization_id")
      .eq("id", business_id)
      .maybeSingle();
    if (businessErr) {
      return err("LOOKUP_FAILED", `Business lookup failed: ${businessErr.message}`, 500, {
        user_id: user.id, business_id,
      });
    }
    if (!business) {
      return err("NOT_FOUND", "Business not found", 404, { user_id: user.id, business_id });
    }
    if (organization_id && organization_id !== business.organization_id) {
      return err(
        "BAD_REQUEST",
        "organization_id does not match business",
        400,
        { user_id: user.id, business_id, organization_id, expected: business.organization_id },
      );
    }
    const orgId = business.organization_id;

    const { data: userRole, error: roleErr } = await admin
      .from("user_roles")
      .select("id")
      .eq("user_id", user.id)
      .eq("organization_id", orgId)
      .maybeSingle();
    if (roleErr) {
      return err("LOOKUP_FAILED", `Role lookup failed: ${roleErr.message}`, 500, {
        user_id: user.id, organization_id: orgId,
      });
    }
    if (!userRole) {
      // Platform admins are allowed to install packs on behalf of any tenant
      // (used by the Platform Administration "Install pack on tenant" wizard).
      // Everyone else must have a role in the org before installing.
      const { data: isPlatformAdmin, error: paErr } = await admin
        .rpc("is_platform_admin", { _user_id: user.id })
        .single();
      if (paErr) {
        return err("LOOKUP_FAILED", `Platform-admin check failed: ${paErr.message}`, 500, {
          user_id: user.id, organization_id: orgId,
        });
      }
      if (!isPlatformAdmin) {
        // Distinct code so the frontend can show "Finishing tenant setup…"
        // rather than a generic permission-denied toast.
        return err(
          "AUTH_NO_ROLE_FOR_ORG",
          "You don't have access to this organization yet. Tenant setup may still be in progress.",
          403,
          { user_id: user.id, organization_id: orgId, business_id },
        );
      }
      console.log("[install-localization-pack] platform-admin on-behalf-of install", {
        actor_user_id: user.id, organization_id: orgId, business_id,
      });
    }

    // Resolve pack_id from country_code if needed
    let resolvedPackId = pack_id as string | undefined;
    if (!resolvedPackId && country_code) {
      const { data: countryPack, error: packErr } = await admin
        .from("localization_packs")
        .select("id")
        .eq("country_code", country_code)
        .eq("is_active", true)
        .eq("is_published", true)
        .limit(1)
        .maybeSingle();
      if (packErr) {
        return err("LOOKUP_FAILED", `Pack lookup failed: ${packErr.message}`, 500, {
          user_id: user.id, country_code,
        });
      }
      if (!countryPack) {
        if (auto_install) {
          return reply({
            success: true,
            skipped: true,
            status: "generic",
            message: "No pack available for this country",
          });
        }
        return err("NOT_FOUND", "No pack found for this country", 404, {
          user_id: user.id, country_code,
        });
      }
      resolvedPackId = countryPack.id;
    }
    if (!resolvedPackId) {
      return err("BAD_REQUEST", "pack_id or country_code is required", 400, { user_id: user.id });
    }

    // Skeleton-pack gate (H2). Packs flagged maturity='skeleton' refuse to
    // install unless the caller explicitly acknowledges that the pack lacks
    // production-grade content. Surface a 409 with template counts so the
    // UI can show an honest "this pack is incomplete" dialog.
    const { data: gate, error: gateErr } = await admin.rpc(
      "check_pack_install_allowed",
      { _pack_id: resolvedPackId, _acknowledge_skeleton: !!acknowledge_skeleton },
    );
    if (gateErr) {
      return err("LOOKUP_FAILED", `Maturity gate failed: ${gateErr.message}`, 500, {
        user_id: user.id, pack_id: resolvedPackId,
      });
    }
    const gateResult = (gate ?? {}) as Record<string, unknown>;
    if (gateResult.ok === false) {
      return err(
        "INSTALL_PRECONDITION_FAILED",
        String(gateResult.message ?? "Pack install blocked by maturity gate."),
        409,
        {
          user_id: user.id,
          pack_id: resolvedPackId,
          reason: gateResult.reason,
          maturity: gateResult.maturity,
          template_counts: gateResult.template_counts,
        },
      );
    }

    // Atomic install via SQL RPC.
    // The RPC re-raises with the original SQLSTATE and a HINT carrying the
    // failing step name (e.g. "seed_tax_rates"), so we can classify the
    // failure into a UI-friendly code.
    const { data: installResult, error: installErr } = await admin.rpc(
      "install_localization_pack_atomic",
      {
        _business_id: business_id,
        _pack_id: resolvedPackId,
        _installed_by: user.id,
        _force_reseed: !!force_reseed,
      },
    );
    if (installErr) {
      const classified = classifyInstallError(installErr as any);
      return err(classified.code, classified.userMessage, classified.status, {
        user_id: user.id,
        business_id,
        pack_id: resolvedPackId,
        sqlstate: (installErr as any).code,
        step: (installErr as any).hint,
        pg_message: installErr.message,
        pg_detail: (installErr as any).details,
      });
    }

    // Post-install GL auto-mapping (atomic, single RPC).
    // payroll_finalize_pack_install_v2 applies every suggestion AND
    // creates-and-maps accounts for keys without suggestions inside one
    // transaction, returning per-key failures so we can surface a precise
    // diagnostic instead of "1 key(s) failed".
    let glMappingsApplied = 0;
    let glMappingsCreated = 0;
    let glFailures: Array<Record<string, unknown>> = [];
    try {
      const { data: finalizeRes, error: finalizeErr } = await admin.rpc(
        "payroll_finalize_pack_install_v2",
        { _org_id: orgId, _business_id: business_id },
      );
      if (finalizeErr) {
        glFailures = [{ phase: "finalize_rpc", reason: finalizeErr.message }];
      } else {
        const applied = ((finalizeRes as any)?.applied_mappings ?? []) as unknown[];
        const created = ((finalizeRes as any)?.created_accounts ?? []) as unknown[];
        const failures = ((finalizeRes as any)?.failures ?? []) as Array<Record<string, unknown>>;
        glMappingsApplied = Array.isArray(applied) ? applied.length : 0;
        glMappingsCreated = Array.isArray(created) ? created.length : 0;
        glFailures = Array.isArray(failures) ? failures : [];
      }
    } catch (mapErr) {
      glFailures = [{ phase: "exception", reason: (mapErr as any)?.message ?? String(mapErr) }];
    }

    // Phase 2: publish legal-order kind defaults from the installed pack.
    // The pack is the source of truth for legal behaviour; this projects it
    // into the tenant-facing garnishment_kind_defaults table used by the
    // engine + UI. Non-fatal — pack install still succeeds if this fails.
    let legalOrderKindsInstalled = 0;
    let legalOrderKindsError: string | null = null;
    try {
      const { data: kindsCount, error: kindsErr } = await admin.rpc(
        "install_legal_order_kind_defaults",
        { p_organization_id: orgId, p_pack_id: resolvedPackId },
      );
      if (kindsErr) {
        legalOrderKindsError = kindsErr.message;
        console.warn("[install-localization-pack] legal-order kind projection failed", {
          business_id, pack_id: resolvedPackId, reason: kindsErr.message,
        });
      } else {
        legalOrderKindsInstalled = Number(kindsCount ?? 0);
      }
    } catch (kindsExc) {
      legalOrderKindsError = (kindsExc as any)?.message ?? String(kindsExc);
    }


    const result = (installResult as any) || {};
    const responseBody = {
      ...result,
      summary: {
        ...(result.summary || {}),
        gl_mappings_auto: {
          applied_existing: glMappingsApplied,
          created_new: glMappingsCreated,
          failures: glFailures,
        },
      },
    };

    // Hard-block only when real failures remain after the atomic attempt.
    if (glFailures.length > 0) {
      console.warn("[install-localization-pack] partial-success: gl auto-mapping failures", {
        user_id: user.id, business_id, failures: glFailures,
      });
      const summary = glFailures
        .slice(0, 3)
        .map((f) => `${f.setting_key ?? f.phase}: ${f.reason}`)
        .join("; ");
      return reply({
        ...responseBody,
        success: false,
        error:
          `Pack installed but GL auto-provisioning could not finish (${glFailures.length} issue${glFailures.length === 1 ? "" : "s"}): ${summary}. ` +
          `Open the payroll GL mapping screen to resolve the remaining keys.`,
      });
    }

    // F4: post-install token registry assertion.
    // Packs whose return templates reference tokens (employee.tax_pin,
    // sum_employee_amount, etc.) must seed those tokens in
    // pack_token_registry so the structured editors can offer them. Packs
    // that intentionally rely only on platform-reserved tokens must
    // explicitly opt in via localization_packs.tokens_inherit_platform.
    try {
      const { data: packMeta } = await admin
        .from("localization_packs")
        .select("tokens_inherit_platform")
        .eq("id", resolvedPackId)
        .maybeSingle();
      const inherits = !!(packMeta as any)?.tokens_inherit_platform;
      if (!inherits) {
        const { count } = await admin
          .from("pack_token_registry")
          .select("id", { count: "exact", head: true })
          .eq("pack_id", resolvedPackId);
        if (!count || count === 0) {
          console.warn("[install-localization-pack] pack-token-registry-empty", {
            pack_id: resolvedPackId,
          });
          await admin.from("payroll_diagnostics").insert({
            organization_id: orgId,
            pack_id: resolvedPackId,
            template_code: null,
            surface: "pack_install",
            severity: "warning",
            code: "PACK_TOKEN_REGISTRY_EMPTY",
            message:
              "Pack installed but no token registry rows exist. Template authors will only see platform-reserved tokens. Set localization_packs.tokens_inherit_platform=true if this is intentional, otherwise seed pack_token_registry.",
            details: { pack_id: resolvedPackId },
          }).then(() => {}, () => {});
        }
      }
    } catch (e) {
      console.warn("[install-localization-pack] token-registry-check-failed", e);
    }

    console.log("[install-localization-pack] success", {
      user_id: user.id, business_id, pack_id: resolvedPackId,
    });
    return reply({ ...responseBody, success: true });
  } catch (e) {
    console.error("[install-localization-pack] uncaught", e);
    return reply({ error: (e as any)?.message ?? String(e), code: "INTERNAL" satisfies ErrorCode }, 500);
  }

}

