/**
 * MyOnboarding — employee self-service onboarding at /me/onboarding.
 *
 * Shows the signed-in employee's onboarding checklist (auto-created from
 * the org's default template on hire) and lets them tick items off. Read /
 * update access is granted by the `employee_onboarding_*_own` RLS policies.
 */
import { useEffect, useMemo, useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Progress } from "@/components/ui/progress";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Skeleton } from "@/components/ui/skeleton";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { CheckCircle2, ClipboardList, Sparkles } from "lucide-react";
import { EmployeeLinkRequired } from "@/components/me/EmployeeLinkRequired";
import { PageHeader, PageBody } from "@/design-system";
import { toast } from "sonner";
import { format } from "date-fns";

interface OnboardingItem {
  id: string;
  title: string;
  description: string | null;
  category: string;
  sort_order: number;
  is_completed: boolean;
  completed_at: string | null;
}

interface Onboarding {
  id: string;
  onboarding_type: string;
  status: string;
  started_at: string | null;
  completed_at: string | null;
  items: OnboardingItem[];
}

export default function MyOnboarding() {
  const { currentEmployee, isLoading: employeeLoading } = useCurrentEmployee();
  const [records, setRecords] = useState<Onboarding[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchOnboarding = async (employeeId: string) => {
    setLoading(true);
    const { data, error } = await supabase
      .from("employee_onboarding")
      .select("id,onboarding_type,status,started_at,completed_at,employee_onboarding_items(*)")
      .eq("employee_id", employeeId)
      .order("created_at", { ascending: false });
    if (error) {
      toast.error("Failed to load onboarding", { description: error.message });
    } else {
      setRecords(
        (data ?? []).map((o: any) => ({
          ...o,
          items: (o.employee_onboarding_items ?? []).sort(
            (a: any, b: any) => a.sort_order - b.sort_order,
          ),
        })),
      );
    }
    setLoading(false);
  };

  useEffect(() => {
    if (currentEmployee?.id) void fetchOnboarding(currentEmployee.id);
  }, [currentEmployee?.id]);

  const toggleItem = async (itemId: string, completed: boolean) => {
    const { error } = await supabase
      .from("employee_onboarding_items")
      .update({
        is_completed: completed,
        completed_at: completed ? new Date().toISOString() : null,
      })
      .eq("id", itemId);
    if (error) {
      toast.error("Failed to update", { description: error.message });
      return;
    }
    if (currentEmployee?.id) void fetchOnboarding(currentEmployee.id);
  };

  if (employeeLoading) {
    return <Skeleton className="h-48 w-full" />;
  }

  if (!currentEmployee) {
    return <EmployeeLinkRequired />;
  }

  return (
    <>
      <PageHeader
        title="My Onboarding"
        description="Tasks to get you set up at your new role. Tick them off as you complete them."
      />
      <PageBody>
        {loading ? (
        <Skeleton className="h-48 w-full" />
      ) : records.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center">
            <Sparkles className="h-10 w-10 text-muted-foreground mx-auto mb-3" />
            <p className="font-medium">You're all set!</p>
            <p className="text-sm text-muted-foreground">
              No onboarding tasks assigned. If you think this is wrong, please
              reach out to HR.
            </p>
          </CardContent>
        </Card>
      ) : (
        records.map((rec) => <OnboardingCard key={rec.id} record={rec} onToggle={toggleItem} />)
      )}
      </PageBody>
    </>
  );
}

function OnboardingCard({
  record,
  onToggle,
}: {
  record: Onboarding;
  onToggle: (id: string, done: boolean) => void;
}) {
  const completed = record.items.filter((i) => i.is_completed).length;
  const total = record.items.length;
  const pct = total ? Math.round((completed / total) * 100) : 0;

  const grouped = useMemo(() => {
    const map = new Map<string, OnboardingItem[]>();
    record.items.forEach((i) => {
      const cat = i.category || "general";
      if (!map.has(cat)) map.set(cat, []);
      map.get(cat)!.push(i);
    });
    return Array.from(map.entries());
  }, [record.items]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-4">
          <div>
            <CardTitle className="capitalize">
              {record.onboarding_type.replace(/_/g, " ")} onboarding
            </CardTitle>
            <CardDescription>
              {record.status === "completed"
                ? `Completed ${
                    record.completed_at
                      ? format(new Date(record.completed_at), "MMM d, yyyy")
                      : ""
                  }`
                : `${completed}/${total} tasks done`}
            </CardDescription>
          </div>
          <Badge variant={record.status === "completed" ? "default" : "secondary"}>
            {record.status === "completed" ? (
              <span className="flex items-center gap-1">
                <CheckCircle2 className="h-3 w-3" /> Complete
              </span>
            ) : (
              `${pct}%`
            )}
          </Badge>
        </div>
        <Progress value={pct} className="mt-3" />
      </CardHeader>
      <CardContent>
        <div className="space-y-5">
          {grouped.map(([cat, items]) => (
            <div key={cat}>
              <div className="mb-2 text-xs font-semibold uppercase text-muted-foreground">
                {cat.replace(/_/g, " ")}
              </div>
              <div className="space-y-2">
                {items.map((item) => (
                  <label
                    key={item.id}
                    className="flex items-start gap-3 rounded-md p-2 cursor-pointer hover:bg-muted/40"
                  >
                    <Checkbox
                      checked={item.is_completed}
                      onCheckedChange={(c) => onToggle(item.id, !!c)}
                      className="mt-0.5"
                    />
                    <div className="flex-1 min-w-0">
                      <p
                        className={
                          item.is_completed
                            ? "text-sm line-through text-muted-foreground"
                            : "text-sm font-medium"
                        }
                      >
                        {item.title}
                      </p>
                      {item.description && (
                        <p className="text-xs text-muted-foreground">
                          {item.description}
                        </p>
                      )}
                      {item.completed_at && (
                        <p className="text-xs text-muted-foreground">
                          Completed{" "}
                          {format(new Date(item.completed_at), "MMM d, yyyy")}
                        </p>
                      )}
                    </div>
                  </label>
                ))}
              </div>
            </div>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
