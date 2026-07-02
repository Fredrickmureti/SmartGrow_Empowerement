/**
 * Org Workspace — Overview
 *
 * Landing surface for `/hr/org`. Gives an HR lead an at-a-glance read on
 * organizational structure: how many departments / positions / locations
 * exist, total headcount, and the largest departments by people count.
 *
 * Data sources:
 *   - `v_hr_headcount_by_department` — per-department headcount, already
 *     business-scoped via the underlying employees relation.
 *   - `departments`, `job_positions`, `work_locations` — count-only.
 *
 * Scope: filtered by the current company (`useCompanies().currentCompany.id`)
 * so the numbers always reflect what the user is operating in. RLS still
 * applies on top — this is a UI convenience, not a security boundary.
 *
 * This page replaces the placeholder index redirect to `/hr/org/departments`
 * and makes the `ORG_NAV` "Overview" item resolve to an actual workspace
 * landing — the Wave-1 benchmark surface for the Org sub-app.
 */

import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Building2, Briefcase, MapPin, Users, ArrowRight, Network } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useCompanies } from "@/contexts/BusinessContext";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface HeadcountRow {
  department_id: string | null;
  department_name: string | null;
  headcount: number | null;
}

function useOrgOverview(businessId: string | undefined) {
  return useQuery({
    queryKey: ["hr", "org", "overview", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      // Parallel reads — independent counts + the headcount view.
      const [headcountRes, deptCountRes, posCountRes, locCountRes] = await Promise.all([
        supabase
          .from("v_hr_headcount_by_department")
          .select("department_id, department_name, headcount")
          .eq("business_id", businessId!)
          .order("headcount", { ascending: false })
          .limit(50),
        supabase
          .from("departments")
          .select("id", { count: "exact", head: true })
          .eq("business_id", businessId!),
        supabase
          .from("job_positions")
          .select("id", { count: "exact", head: true })
          .eq("business_id", businessId!),
        supabase
          .from("work_locations")
          .select("id", { count: "exact", head: true })
          .eq("business_id", businessId!),
      ]);

      if (headcountRes.error) throw headcountRes.error;
      if (deptCountRes.error) throw deptCountRes.error;
      if (posCountRes.error) throw posCountRes.error;
      if (locCountRes.error) throw locCountRes.error;

      const rows = (headcountRes.data ?? []) as HeadcountRow[];
      const totalHeadcount = rows.reduce((sum, r) => sum + (r.headcount ?? 0), 0);

      return {
        topDepartments: rows.slice(0, 6),
        totalHeadcount,
        departmentCount: deptCountRes.count ?? 0,
        positionCount: posCountRes.count ?? 0,
        locationCount: locCountRes.count ?? 0,
      };
    },
  });
}

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  hint?: string;
}

function StatCard({ label, value, icon: Icon, href, hint }: StatCardProps) {
  return (
    <Link
      to={href}
      className="group block focus:outline-none focus-visible:ring-2 focus-visible:ring-ring rounded-lg"
    >
      <Card className="h-full transition-colors group-hover:border-foreground/20">
        <CardHeader className="pb-2">
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardDescription className="text-xs font-medium uppercase tracking-wide">
                {label}
              </CardDescription>
              <CardTitle className="mt-1 text-3xl tabular-nums">{value}</CardTitle>
            </div>
            <div className="rounded-md bg-muted p-2">
              <Icon className="h-4 w-4 text-muted-foreground" />
            </div>
          </div>
        </CardHeader>
        {hint ? (
          <CardContent className="pt-0">
            <p className="text-xs text-muted-foreground">{hint}</p>
          </CardContent>
        ) : null}
      </Card>
    </Link>
  );
}

export default function OrgOverview() {
  const { currentCompany } = useCompanies();
  const businessId = currentCompany?.id;
  const { data, isLoading, isError, error } = useOrgOverview(businessId);

  const largestDepartmentShare = useMemo(() => {
    if (!data || data.totalHeadcount === 0) return null;
    const top = data.topDepartments[0];
    if (!top?.headcount) return null;
    return Math.round((top.headcount / data.totalHeadcount) * 100);
  }, [data]);

  if (!businessId) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Select a company</CardTitle>
            <CardDescription>
              Pick a company from the workspace switcher to see its org structure.
            </CardDescription>
          </CardHeader>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6 p-6">
      <header className="flex flex-wrap items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Organization</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Structure, headcount, and change history for {currentCompany?.name ?? "your company"}.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/hr/org/chart">
            <Network className="mr-2 h-4 w-4" />
            View org chart
          </Link>
        </Button>
      </header>

      {isError ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">Could not load org overview</CardTitle>
            <CardDescription>
              {error instanceof Error ? error.message : "Unknown error"}
            </CardDescription>
          </CardHeader>
        </Card>
      ) : null}

      <section className="grid grid-cols-2 gap-3 sm:gap-4 lg:grid-cols-4">
        {isLoading ? (
          Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-[112px] rounded-lg" />
          ))
        ) : (
          <>
            <StatCard
              label="Headcount"
              value={data?.totalHeadcount ?? 0}
              icon={Users}
              href="/hr/employees"
              hint="Active employees across all departments"
            />
            <StatCard
              label="Departments"
              value={data?.departmentCount ?? 0}
              icon={Building2}
              href="/hr/org/departments"
            />
            <StatCard
              label="Positions"
              value={data?.positionCount ?? 0}
              icon={Briefcase}
              href="/hr/org/positions"
            />
            <StatCard
              label="Locations"
              value={data?.locationCount ?? 0}
              icon={MapPin}
              href="/hr/org/locations"
            />
          </>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-base">Largest departments</CardTitle>
              <CardDescription>By active headcount</CardDescription>
            </div>
            {largestDepartmentShare !== null ? (
              <Badge variant="secondary" className="shrink-0">
                Top {largestDepartmentShare}% of headcount
              </Badge>
            ) : null}
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 rounded" />
                ))}
              </div>
            ) : !data || data.topDepartments.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No departments yet.{" "}
                <Link to="/hr/org/departments" className="underline underline-offset-4">
                  Create the first one
                </Link>
                .
              </p>
            ) : (
              <ul className="divide-y">
                {data.topDepartments.map((row) => {
                  const share =
                    data.totalHeadcount > 0
                      ? Math.round(((row.headcount ?? 0) / data.totalHeadcount) * 100)
                      : 0;
                  return (
                    <li key={row.department_id ?? row.department_name} className="py-2.5">
                      <div className="flex items-center justify-between gap-4">
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center justify-between gap-2 text-sm">
                            <span className="truncate font-medium">
                              {row.department_name ?? "Unassigned"}
                            </span>
                            <span className="text-muted-foreground tabular-nums">
                              {row.headcount ?? 0}
                            </span>
                          </div>
                          <div className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-muted">
                            <div
                              className="h-full rounded-full bg-foreground/70"
                              style={{ width: `${share}%` }}
                              aria-hidden
                            />
                          </div>
                        </div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Jump to</CardTitle>
            <CardDescription>Common org-structure tasks</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {[
              { href: "/hr/org/departments", label: "Manage departments" },
              { href: "/hr/org/positions", label: "Open & filled positions" },
              { href: "/hr/org/locations", label: "Work locations" },
              { href: "/hr/org/history", label: "Change history" },
            ].map((link) => (
              <Button
                key={link.href}
                asChild
                variant="ghost"
                className="w-full justify-between"
              >
                <Link to={link.href}>
                  <span>{link.label}</span>
                  <ArrowRight className="h-4 w-4 text-muted-foreground" />
                </Link>
              </Button>
            ))}
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
