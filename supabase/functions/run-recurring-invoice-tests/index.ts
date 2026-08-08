// Runner for the recurring-invoicing database test suites.
//
// The billing engine is a database function, so its behavioural tests are
// database functions too. `test_recurring_invoicing_engine` performs real
// writes inside a subtransaction that is always rolled back, which is why it
// needs the service role and is not exposed to the app's users.
//
// Guarded: only a caller presenting the service role key may run it.
import { createClient } from "npm:@supabase/supabase-js@2";
import { corsHeaders } from "npm:@supabase/supabase-js@2/cors";

type TestRow = { test_name: string; passed: boolean; detail: string | null };

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body, null, 2), {
    status,
    headers: { ...corsHeaders, "Content-Type": "application/json" },
  });

Deno.serve(async (req) => {
  if (req.method === "OPTIONS") return new Response("ok", { headers: corsHeaders });

  const serviceKey = Deno.env.get("SUPABASE_SERVICE_ROLE_KEY") ?? "";
  const presented = (req.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!serviceKey || presented !== serviceKey) {
    return json({ error: "forbidden: service role key required" }, 403);
  }

  const supabase = createClient(Deno.env.get("SUPABASE_URL")!, serviceKey);

  const suites: Record<string, TestRow[]> = {};
  for (const fn of ["test_recurring_calendar", "test_recurring_invoicing_engine"]) {
    const { data, error } = await supabase.rpc(fn);
    if (error) {
      suites[fn] = [{ test_name: "suite", passed: false, detail: error.message }];
      continue;
    }
    suites[fn] = (data ?? []) as TestRow[];
  }

  const all = Object.values(suites).flat();
  const failed = all.filter((t) => !t.passed);

  return json(
    {
      ok: failed.length === 0,
      total: all.length,
      passed: all.length - failed.length,
      failed: failed.length,
      failures: failed,
      suites,
    },
    failed.length === 0 ? 200 : 500,
  );
});
