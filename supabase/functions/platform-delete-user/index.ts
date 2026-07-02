// Platform-admin user deletion.
//
// Permanently removes an auth.users row and, if the user owns any
// organizations, deletes those organizations first via the canonical
// `platform_delete_organization` RPC (which uses set_config('app.reset_in_progress', ...)
// to bypass app-install gates and cascade tenant data cleanly).
//
// Caller must be an active platform admin.
// Body must include `confirmation` matching the user's email exactly
// (case-insensitive, trimmed) — defense in depth on top of the UI dialog.
import { requirePlatformAdmin } from "../_shared/requirePlatformAdmin.ts";
import { runStorageGc } from "../_shared/storageGc.ts";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") {
    return new Response("ok", { headers: corsHeaders });
  }

  try {
    const { admin, userId: callerId } = await requirePlatformAdmin(req);

    let body: { user_id?: string; confirmation?: string };
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON body" }, 400);
    }

    const targetUserId = (body.user_id ?? "").trim();
    const confirmation = (body.confirmation ?? "").trim().toLowerCase();
    if (!targetUserId) return json({ error: "user_id is required" }, 400);
    if (!confirmation) return json({ error: "confirmation is required" }, 400);

    if (targetUserId === callerId) {
      return json({ error: "You cannot delete your own account from this dialog." }, 400);
    }

    // Resolve target user
    const { data: targetResp, error: getErr } = await admin.auth.admin.getUserById(targetUserId);
    if (getErr || !targetResp?.user) {
      return json({ error: "User not found" }, 404);
    }
    const targetEmail = (targetResp.user.email ?? "").trim().toLowerCase();
    if (!targetEmail) {
      return json({ error: "Target user has no email — cannot verify confirmation" }, 400);
    }
    if (confirmation !== targetEmail) {
      return json(
        { error: "Confirmation text does not match the user's email exactly." },
        400,
      );
    }

    // Refuse to delete a fellow platform admin via this endpoint
    const { data: isAdminTarget } = await admin.rpc("is_platform_admin", {
      _user_id: targetUserId,
    });
    if (isAdminTarget) {
      return json(
        { error: "Refusing to delete a platform admin. Revoke their admin role first." },
        400,
      );
    }

    // Cascade-delete any organizations the user owns
    const { data: ownedOrgs, error: orgErr } = await admin
      .from("organizations")
      .select("id, name")
      .eq("owner_user_id", targetUserId);
    if (orgErr) {
      return json({ error: `Failed to enumerate owned orgs: ${orgErr.message}` }, 500);
    }

    const deletedOrgs: string[] = [];
    const orgWarnings: string[] = [];
    for (const org of ownedOrgs ?? []) {
      const token = `admin-delete-user:${callerId}:${Date.now()}`;
      const { error: delOrgErr } = await admin.rpc("platform_delete_organization", {
        p_org_id: org.id,
        p_confirmation_token: token,
      });
      if (delOrgErr) {
        orgWarnings.push(`${org.name}: ${delOrgErr.message}`);
      } else {
        deletedOrgs.push(org.name);
      }
    }

    // Clean up tenant-side membership/role rows that don't have FK CASCADE
    // back to auth.users (best-effort — auth.users delete will also cascade
    // public-schema FKs that DO declare ON DELETE CASCADE).
    await admin.from("user_roles").delete().eq("user_id", targetUserId);
    await admin.from("user_business_access").delete().eq("user_id", targetUserId);
    await admin.from("user_branch_assignments").delete().eq("user_id", targetUserId);
    await admin.from("profiles").delete().eq("user_id", targetUserId);

    // Purge user-owned storage (user-avatars, etc.) via the central GC.
    let storageGc: unknown = null;
    try {
      storageGc = await runStorageGc(admin, {
        scope: "user",
        id: targetUserId,
        triggeredBy: callerId,
        triggerSource: "platform-delete-user",
      });
    } catch (e) {
      console.error("[platform-delete-user] storage-gc failed:", e);
      storageGc = { ok: false, error: e instanceof Error ? e.message : String(e) };
    }

    // Finally delete the auth user
    const { error: delUserErr } = await admin.auth.admin.deleteUser(targetUserId);
    if (delUserErr) {
      return json(
        {
          error: `Auth user deletion failed: ${delUserErr.message}`,
          deleted_organizations: deletedOrgs,
          warnings: orgWarnings,
        },
        500,
      );
    }

    return json({
      ok: true,
      deleted_user_id: targetUserId,
      deleted_email: targetEmail,
      deleted_organizations: deletedOrgs,
      warnings: orgWarnings,
      storage_gc: storageGc,
    }, 200);
  } catch (e) {
    if (e instanceof Response) return withCors(e);
    console.error("[platform-delete-user] unexpected:", e);
    return json({ error: "Unexpected server error" }, 500);
  }
});

function json(body: unknown, status: number): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}

async function withCors(r: Response): Promise<Response> {
  const text = await r.text();
  return new Response(text, {
    status: r.status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });
}