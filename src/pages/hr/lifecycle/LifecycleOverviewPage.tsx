/**
 * Lifecycle Overview — cross-pipeline command center.
 *
 * Surfaces counts per event family in the last 30 days plus quick-drill
 * links into the individual pipeline queues. First real screen for
 * /hr/lifecycle (replaces the stub).
 */
import { useMemo } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Loader2, ClipboardList, CalendarCheck, Repeat, CalendarOff, FileSignature, History, ArrowRight } from "lucide-react";
import { PageHeader, PageBody } from "@/design-system";
import { Button } from "@/components/ui/button";
import { useLifecycleEventCounts, LIFECYCLE_EVENT_LABELS, lifecycleEventTone, type LifecycleEventType } from "@/hooks/hr/useLifecycleEvents";

interface Pipeline {
  key: string;
  title: string;
  description: string;
  route: string;
  icon: React.ElementType;
  events: LifecycleEventType[];
}

const PIPELINES: Pipeline[] = [
  {
    key: "onboarding",
    title: "Onboarding",
    description: "Employees between hire and onboarding completion.",
    route: "/hr/lifecycle/onboarding",
    icon: ClipboardList,
    events: ["hired", "onboarding_started", "onboarding_completed"],
  },
  {
    key: "probation",
    title: "Probation",
    description: "Probation started, extended, or ended.",
    route: "/hr/lifecycle/probation",
    icon: CalendarCheck,
    events: ["probation_started", "probation_ended", "probation_extended"],
  },
  {
    key: "transfers",
    title: "Transfers",
    description: "Department, location, or manager changes.",
    route: "/hr/lifecycle/transfers",
    icon: Repeat,
    events: ["department_transferred", "location_transferred", "manager_changed", "position_changed", "promoted", "demoted"],
  },
  {
    key: "renewals",
    title: "Contract renewals",
    description: "Contracts renewed, amended, or expired.",
    route: "/hr/lifecycle/renewals",
    icon: FileSignature,
    events: ["contract_renewed", "contract_amended", "contract_activated", "contract_expired"],
  },
  {
    key: "offboarding",
    title: "Offboarding",
    description: "Termination through final settlement and archive.",
    route: "/hr/lifecycle/offboarding",
    icon: CalendarOff,
    events: ["termination_initiated", "terminated", "offboarding_started", "offboarding_completed", "final_settlement_paid", "archived"],
  },
];

export default function LifecycleOverviewPage() {
  const navigate = useNavigate();
  const { counts, total, isLoading } = useLifecycleEventCounts(30);

  const summaries = useMemo(
    () =>
      PIPELINES.map((p) => {
        const total = p.events.reduce((n, t) => n + (counts.get(t) ?? 0), 0);
        const breakdown = p.events
          .map((t) => ({ type: t, n: counts.get(t) ?? 0 }))
          .filter((b) => b.n > 0);
        return { ...p, total, breakdown };
      }),
    [counts],
  );

  return (
    <>
      <PageHeader
        eyebrow="HR · Lifecycle"
        title="Lifecycle overview"
        description="Cross-pipeline snapshot of employee transitions in the last 30 days."
      />
      <PageBody fullWidth className="gap-4 sm:gap-6">
        {isLoading ? (
          <div className="flex items-center justify-center py-16">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <>
            <Card>
              <CardContent className="p-4 flex items-center justify-between gap-3">
                <div className="flex items-center gap-3">
                  <History className="h-5 w-5 text-muted-foreground" />
                  <div>
                    <div className="text-sm font-medium">{total} lifecycle event{total === 1 ? "" : "s"} in the last 30 days</div>
                    <div className="text-xs text-muted-foreground">Full log available on the "All events" page.</div>
                  </div>
                </div>
                <Button variant="outline" size="sm" onClick={() => navigate("/hr/lifecycle/timeline")}>
                  Open timeline <ArrowRight className="h-4 w-4 ml-1" />
                </Button>
              </CardContent>
            </Card>

            <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
              {summaries.map((s) => {
                const Icon = s.icon;
                return (
                  <Card
                    key={s.key}
                    className="cursor-pointer hover:shadow-md transition-shadow"
                    onClick={() => navigate(s.route)}
                  >
                    <CardContent className="p-4 space-y-3">
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                          <Icon className="h-4 w-4 text-muted-foreground" />
                          <span className="text-sm font-medium">{s.title}</span>
                        </div>
                        <span className="text-2xl font-bold">{s.total}</span>
                      </div>
                      <p className="text-xs text-muted-foreground">{s.description}</p>
                      {s.breakdown.length > 0 && (
                        <div className="flex flex-wrap gap-1 pt-1">
                          {s.breakdown.map((b) => (
                            <Badge key={b.type} variant={lifecycleEventTone(b.type)} className="text-xs">
                              {LIFECYCLE_EVENT_LABELS[b.type]} · {b.n}
                            </Badge>
                          ))}
                        </div>
                      )}
                    </CardContent>
                  </Card>
                );
              })}
            </div>
          </>
        )}
      </PageBody>
    </>
  );
}
