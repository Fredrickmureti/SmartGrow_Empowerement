/**
 * Contracts Workspace — Overview
 *
 * Benchmark landing surface for `/hr/contracts`. Mirrors the Org Overview
 * pattern: KPI strip + a focused operational panel (the expiry pipeline,
 * which is the single most actionable list in the contracts domain).
 *
 * Data sources:
 *   - `employee_contracts` — counts by status (running / draft / pending /
 *     expired) scoped by business_id.
 *   - `v_hr_contract_expiry_pipeline` — pre-bucketed (0-30 / 31-60 / 61-90
 *     days) view of running contracts about to expire.
 *
 * Scope: filtered by `useCompanies().currentCompany.id`. RLS is still
 * enforced server-side; the business_id filter is a UI affordance so the
 * page reflects the workspace the user is operating in.
 */

import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  FileSignature,
  FileText,
  Inbox,
  ShieldCheck,
  AlertCircle,
  ArrowRight,
  Repeat,
} from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useCompanies } from "@/contexts/BusinessContext";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";

interface ExpiryRow {
  contract_id: string;
  employee_name: string | null;
  contract_reference: string | null;
  end_date: string | null;
  days_to_expiry: number | null;
  bucket: "0-30" | "31-60" | "61-90" | null;
}

function useContractsOverview(businessId: string | undefined) {
  return useQuery({
    queryKey: ["hr", "contracts", "overview", businessId],
    enabled: Boolean(businessId),
    queryFn: async () => {
      const base = () =>
        supabase
          .from("employee_contracts")
          .select("id", { count: "exact", head: true })
          .eq("business_id", businessId!);

      const [activeRes, draftRes, pendingRes, expiringRes, expiryListRes] = await Promise.all([
        base().eq("status", "running"),
        base().eq("status", "draft"),
        base().eq("status", "pending_approval"),
        supabase
          .from("v_hr_contract_expiry_pipeline")
          .select("contract_id", { count: "exact", head: true })
          .eq("business_id", businessId!),
        supabase
          .from("v_hr_contract_expiry_pipeline")
          .select(
            "contract_id, employee_name, contract_reference, end_date, days_to_expiry, bucket",
          )
          .eq("business_id", businessId!)
          .order("days_to_expiry", { ascending: true })
          .limit(8),
      ]);

      if (activeRes.error) throw activeRes.error;
      if (draftRes.error) throw draftRes.error;
      if (pendingRes.error) throw pendingRes.error;
      if (expiringRes.error) throw expiringRes.error;
      if (expiryListRes.error) throw expiryListRes.error;

      return {
        active: activeRes.count ?? 0,
        drafts: draftRes.count ?? 0,
        pending: pendingRes.count ?? 0,
        expiring: expiringRes.count ?? 0,
        expirySoon: (expiryListRes.data ?? []) as ExpiryRow[],
      };
    },
  });
}

interface StatCardProps {
  label: string;
  value: number | string;
  icon: React.ComponentType<{ className?: string }>;
  href: string;
  tone?: "default" | "warning";
}

function StatCard({ label, value, icon: Icon, href, tone = "default" }: StatCardProps) {
  return (
    <Link
      to={href}
      className="group block rounded-lg focus:outline-none focus-visible:ring-2 focus-visible:ring-ring"
    >
      <Card
        className={
          "h-full transition-colors group-hover:border-foreground/20 " +
          (tone === "warning" ? "border-amber-500/30" : "")
        }
      >
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
      </Card>
    </Link>
  );
}

function bucketBadge(bucket: ExpiryRow["bucket"]) {
  if (bucket === "0-30") return <Badge variant="destructive">≤ 30 days</Badge>;
  if (bucket === "31-60") return <Badge className="bg-amber-500/15 text-amber-700 hover:bg-amber-500/20">31–60 days</Badge>;
  return <Badge variant="secondary">61–90 days</Badge>;
}

export default function ContractsOverview() {
  const { currentCompany } = useCompanies();
  const businessId = currentCompany?.id;
  const { data, isLoading, isError, error } = useContractsOverview(businessId);

  if (!businessId) {
    return (
      <div className="p-6">
        <Card>
          <CardHeader>
            <CardTitle>Select a company</CardTitle>
            <CardDescription>
              Pick a company from the workspace switcher to view its contracts.
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
          <h1 className="text-2xl font-semibold tracking-tight">Contracts</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            Drafts, approvals, renewals, and the expiry pipeline for{" "}
            {currentCompany?.name ?? "your company"}.
          </p>
        </div>
        <Button asChild variant="outline" size="sm">
          <Link to="/hr/contracts/renewals">
            <Repeat className="mr-2 h-4 w-4" />
            Renew a contract
          </Link>
        </Button>
      </header>

      {isError ? (
        <Card className="border-destructive/40">
          <CardHeader>
            <CardTitle className="text-destructive">
              Could not load contracts overview
            </CardTitle>
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
              label="Active"
              value={data?.active ?? 0}
              icon={ShieldCheck}
              href="/hr/contracts/active"
            />
            <StatCard
              label="Drafts"
              value={data?.drafts ?? 0}
              icon={FileText}
              href="/hr/contracts/drafts"
            />
            <StatCard
              label="Pending approval"
              value={data?.pending ?? 0}
              icon={Inbox}
              href="/hr/contracts/pending"
            />
            <StatCard
              label="Expiring ≤ 90d"
              value={data?.expiring ?? 0}
              icon={AlertCircle}
              href="/hr/contracts/expiring"
              tone={data && data.expiring > 0 ? "warning" : "default"}
            />
          </>
        )}
      </section>

      <section className="grid gap-4 lg:grid-cols-3">
        <Card className="lg:col-span-2">
          <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
            <div>
              <CardTitle className="text-base">Expiring soon</CardTitle>
              <CardDescription>
                Running contracts ending in the next 90 days
              </CardDescription>
            </div>
            <Button asChild variant="ghost" size="sm">
              <Link to="/hr/contracts/expiring">
                View all
                <ArrowRight className="ml-1 h-3.5 w-3.5" />
              </Link>
            </Button>
          </CardHeader>
          <CardContent>
            {isLoading ? (
              <div className="space-y-3">
                {Array.from({ length: 4 }).map((_, i) => (
                  <Skeleton key={i} className="h-9 rounded" />
                ))}
              </div>
            ) : !data || data.expirySoon.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No contracts expiring in the next 90 days.
              </p>
            ) : (
              <ul className="divide-y">
                {data.expirySoon.map((row) => (
                  <li key={row.contract_id} className="py-2.5">
                    <div className="flex items-center justify-between gap-4">
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2 text-sm">
                          <span className="truncate font-medium">
                            {row.employee_name ?? "—"}
                          </span>
                          {row.contract_reference ? (
                            <span className="truncate text-muted-foreground">
                              · {row.contract_reference}
                            </span>
                          ) : null}
                        </div>
                        <div className="mt-0.5 text-xs text-muted-foreground tabular-nums">
                          Ends {row.end_date ?? "—"}
                          {row.days_to_expiry !== null
                            ? ` · ${row.days_to_expiry} day${row.days_to_expiry === 1 ? "" : "s"}`
                            : ""}
                        </div>
                      </div>
                      {bucketBadge(row.bucket)}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="text-base">Jump to</CardTitle>
            <CardDescription>Common contract tasks</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Button asChild variant="ghost" className="w-full justify-start">
              <Link to="/hr/contracts/drafts">
                <FileText className="mr-2 h-4 w-4" />
                Continue a draft
              </Link>
            </Button>
            <Button asChild variant="ghost" className="w-full justify-start">
              <Link to="/hr/contracts/pending">
                <Inbox className="mr-2 h-4 w-4" />
                Review pending approvals
              </Link>
            </Button>
            <Button asChild variant="ghost" className="w-full justify-start">
              <Link to="/hr/contracts/amendments">
                <FileSignature className="mr-2 h-4 w-4" />
                Record an amendment
              </Link>
            </Button>
            <Button asChild variant="ghost" className="w-full justify-start">
              <Link to="/hr/contracts/templates">
                <FileSignature className="mr-2 h-4 w-4" />
                Manage templates
              </Link>
            </Button>
          </CardContent>
        </Card>
      </section>
    </div>
  );
}
