import { serve } from "https://deno.land/std@0.168.0/http/server.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2";

const corsHeaders = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers":
    "authorization, x-client-info, apikey, content-type",
};

interface ClearPOSDataRequest {
  organization_id: string;
  categories: string[];
}

// Define deletion order for each category (respecting FK constraints)
// Tables are listed in the order they must be deleted (children first)
const categoryTableOrder: Record<string, string[]> = {
  transactions: [
    "pos_transaction_item_modifiers", // child of pos_transaction_items
    "pos_transaction_items",          // child of pos_transactions
    "pos_transaction_payments",       // child of pos_transactions
    "pos_split_bill_items",           // child of pos_split_bills
    "pos_split_bill_portions",        // child of pos_split_bills
    "pos_split_bills",                // child of pos_transactions
    "pos_kitchen_orders",             // child of pos_transactions
    "pos_transactions",               // parent
  ],
  shifts: [
    "pos_cash_movements",  // child of pos_shifts
    "pos_shifts",          // parent
  ],
  table_sessions: [
    "pos_table_transfers", // references table sessions
    "pos_table_sessions",  // parent
  ],
  held_transactions: [
    "pos_held_transactions", // standalone
  ],
};

serve(async (req) => {
  // Handle CORS preflight
  if (req.method === "OPTIONS") {
    return new Response(null, { headers: corsHeaders });
  }

  try {
    // Get authorization header
    const authHeader = req.headers.get("Authorization");
    if (!authHeader) {
      return new Response(
        JSON.stringify({ error: "Missing authorization header" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Create Supabase clients
    const supabaseUrl = Deno.env.get("SUPABASE_URL")!;
    const supabaseServiceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY")!;
    
    // User client for permission checks
    const supabaseUser = createClient(supabaseUrl, Deno.env.get("SUPABASE_ANON_KEY")!, {
      global: { headers: { Authorization: authHeader } },
    });

    // Service role client for deletions (bypasses RLS)
    const supabaseAdmin = createClient(supabaseUrl, supabaseServiceKey);

    // Verify JWT and get user
    const token = authHeader.replace("Bearer ", "");
    const { data: claimsData, error: claimsError } = await supabaseUser.auth.getClaims(token);
    
    if (claimsError || !claimsData?.claims) {
      return new Response(
        JSON.stringify({ error: "Unauthorized" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const userId = claimsData.claims.sub;
    if (!userId) {
      return new Response(
        JSON.stringify({ error: "Invalid token: missing user ID" }),
        { status: 401, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Parse request body
    const body: ClearPOSDataRequest = await req.json();
    const { organization_id, categories } = body;

    if (!organization_id || !categories || categories.length === 0) {
      return new Response(
        JSON.stringify({ error: "Missing organization_id or categories" }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Check user has appropriate role (owner, admin, or super_admin)
    const { data: membership, error: memberError } = await supabaseAdmin
      .from("user_roles")
      .select("role")
      .eq("organization_id", organization_id)
      .eq("user_id", userId)
      .maybeSingle();

    if (memberError || !membership) {
      console.log("Membership check failed:", memberError);
      return new Response(
        JSON.stringify({ error: "User is not a member of this organization" }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    const allowedRoles = ["super_admin", "owner", "admin"];
    if (!allowedRoles.includes(membership.role)) {
      return new Response(
        JSON.stringify({ error: "Insufficient permissions. Only admins can clear POS data." }),
        { status: 403, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Validate categories
    const validCategories = Object.keys(categoryTableOrder);
    const invalidCategories = categories.filter(c => !validCategories.includes(c));
    if (invalidCategories.length > 0) {
      return new Response(
        JSON.stringify({ error: `Invalid categories: ${invalidCategories.join(", ")}` }),
        { status: 400, headers: { ...corsHeaders, "Content-Type": "application/json" } }
      );
    }

    // Build complete ordered list of tables to delete
    const tablesToDelete: string[] = [];
    
    for (const category of categories) {
      const tables = categoryTableOrder[category];
      if (tables) {
        for (const table of tables) {
          if (!tablesToDelete.includes(table)) {
            tablesToDelete.push(table);
          }
        }
      }
    }

    console.log(`Clearing POS data for org ${organization_id}:`, tablesToDelete);

    // Delete data from each table (using service role for reliable deletion)
    const deletedCounts: Record<string, number> = {};

    for (const table of tablesToDelete) {
      try {
        // First get count
        const { count } = await supabaseAdmin
          .from(table)
          .select("*", { count: "exact", head: true })
          .eq("organization_id", organization_id);

        // Then delete
        const { error: deleteError } = await supabaseAdmin
          .from(table)
          .delete()
          .eq("organization_id", organization_id);

        if (deleteError) {
          console.error(`Error deleting from ${table}:`, deleteError);
          // Continue with other tables but log the error
        } else {
          deletedCounts[table] = count || 0;
          console.log(`Deleted ${count || 0} rows from ${table}`);
        }
      } catch (err) {
        console.error(`Exception deleting from ${table}:`, err);
      }
    }

    // Calculate total deleted
    const totalDeleted = Object.values(deletedCounts).reduce((a, b) => a + b, 0);

    // Log the action to audit_logs
    try {
      await supabaseAdmin.from("audit_logs").insert({
        organization_id,
        user_id: userId,
        action: "pos_data_reset",
        entity_type: "pos",
        entity_id: organization_id,
        entity_name: "POS Data Reset",
        changes_summary: `Cleared ${totalDeleted} POS records from ${categories.length} categories`,
        new_values: { categories, deleted_counts: deletedCounts },
      });
    } catch (auditError) {
      console.error("Failed to log audit:", auditError);
      // Don't fail the operation just because audit logging failed
    }

    return new Response(
      JSON.stringify({
        success: true,
        message: "POS data cleared successfully",
        deleted_counts: deletedCounts,
        total_deleted: totalDeleted,
      }),
      { headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  } catch (error: unknown) {
    console.error("Error in clear-pos-data:", error);
    const message = error instanceof Error ? error.message : "Internal server error";
    return new Response(
      JSON.stringify({ error: message }),
      { status: 500, headers: { ...corsHeaders, "Content-Type": "application/json" } }
    );
  }
});
