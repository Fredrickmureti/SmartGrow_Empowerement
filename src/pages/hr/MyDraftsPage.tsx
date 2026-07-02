/**
 * MyDraftsPage — lists the current user's in-progress employee drafts.
 *
 * Thin wrapper around the paged directory RPC with `status='drafts'` and
 * `p_mine_only=true`. Used as the destination of the "My drafts" entry in
 * the user menu so any half-finished record is one click away.
 */
import { useNavigate } from "react-router-dom";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ArrowLeft, FilePlus, Loader2 } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";

interface DraftRow {
  id: string;
  first_name: string | null;
  last_name: string | null;
  employee_number: string | null;
  email: string | null;
  created_at: string;
  updated_at: string;
}

export default function MyDraftsPage() {
  const navigate = useNavigate();
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();

  const enabled = Boolean(currentOrg?.id && currentBusiness?.id && user?.id);

  const query = useInfiniteQuery({
    queryKey: ["my-employee-drafts", currentOrg?.id, currentBusiness?.id, user?.id],
    enabled,
    initialPageParam: null as { created_at: string; id: string } | null,
    queryFn: async ({ pageParam }) => {
      const cursor = pageParam as { created_at: string; id: string } | null;
      const { data, error } = await supabase.rpc("list_employees_paged" as any, {
        p_org_id: currentOrg!.id,
        p_business_id: currentBusiness!.id,
        p_branch_ids: null,
        p_search: null,
        p_status: "drafts",
        p_department_id: null,
        p_position_id: null,
        p_location_id: null,
        p_health: null,
        p_cursor_created_at: cursor?.created_at ?? null,
        p_cursor_id: cursor?.id ?? null,
        p_page_size: 50,
        p_mine_only: true,
      });
      if (error) throw error;
      return (data ?? []) as DraftRow[];
    },
    getNextPageParam: (last) => {
      if (!last || last.length < 50) return undefined;
      const tail = last[last.length - 1];
      return { created_at: tail.created_at, id: tail.id };
    },
  });

  const rows = (query.data?.pages ?? []).flat();

  return (
    <>
      <div className="space-y-4 sm:space-y-6">
        <div className="page-header">
          <div>
            <Button
              variant="ghost"
              size="sm"
              className="-ml-3 mb-2 text-muted-foreground hover:text-foreground"
              onClick={() => navigate("/hr/employees")}
            >
              <ArrowLeft className="h-4 w-4 mr-1" /> Back to employees
            </Button>
            <h1 className="page-title">My drafts</h1>
            <p className="text-sm sm:text-base text-muted-foreground">
              Unfinished employee records you started. Drafts are private to you
              until promoted to active.
            </p>
          </div>
          <Button onClick={() => navigate("/hr/employees/new")}>
            <FilePlus className="h-4 w-4 mr-2" /> New employee
          </Button>
        </div>

        <Card>
          <CardContent className="p-0">
            {query.isLoading ? (
              <div className="flex items-center justify-center py-16 text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin mr-2" /> Loading…
              </div>
            ) : rows.length === 0 ? (
              <div className="py-16 text-center space-y-3">
                <p className="text-muted-foreground">No unfinished employee records.</p>
                <Button variant="outline" onClick={() => navigate("/hr/employees/new")}>
                  Start a new employee
                </Button>
              </div>
            ) : (
              <ul className="divide-y">
                {rows.map((r) => {
                  const name = [r.first_name, r.last_name].filter(Boolean).join(" ") || "Untitled draft";
                  return (
                    <li key={r.id}>
                      <button
                        type="button"
                        onClick={() => navigate(`/hr/employees/${r.id}`)}
                        className="w-full text-left px-4 py-3 hover:bg-muted/40 flex items-center justify-between gap-4"
                      >
                        <div>
                          <div className="font-medium">{name}</div>
                          <div className="text-xs text-muted-foreground">
                            {r.employee_number ?? "—"}
                            {r.email ? ` · ${r.email}` : ""}
                          </div>
                        </div>
                        <div className="text-xs text-muted-foreground shrink-0">
                          Updated {new Date(r.updated_at).toLocaleString()}
                        </div>
                      </button>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        {query.hasNextPage && (
          <div className="flex justify-center">
            <Button
              variant="outline"
              onClick={() => query.fetchNextPage()}
              disabled={query.isFetchingNextPage}
            >
              {query.isFetchingNextPage && <Loader2 className="h-4 w-4 animate-spin mr-2" />}
              Load more
            </Button>
          </div>
        )}
      </div>
    </>
  );
}
