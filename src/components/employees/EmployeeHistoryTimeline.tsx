/**
 * Employee History Timeline (Phase 5)
 * Shows audit-log-based timeline of salary changes, department transfers,
 * position changes, contract events, and other lifecycle events.
 */
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { useQuery } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { format } from "date-fns";
import { Loader2, ArrowRight, Briefcase, DollarSign, Building, FileText, UserCheck, UserMinus, Calendar } from "lucide-react";

interface EmployeeHistoryTimelineProps {
  employeeId: string;
}

interface TimelineEvent {
  id: string;
  date: string;
  type: "salary_change" | "department_change" | "position_change" | "contract" | "hire" | "termination" | "status_change" | "other";
  title: string;
  description: string;
  oldValue?: string;
  newValue?: string;
  icon: React.ReactNode;
}

const typeIcons: Record<string, React.ReactNode> = {
  salary_change: <DollarSign className="h-4 w-4" />,
  department_change: <Building className="h-4 w-4" />,
  position_change: <Briefcase className="h-4 w-4" />,
  contract: <FileText className="h-4 w-4" />,
  hire: <UserCheck className="h-4 w-4" />,
  termination: <UserMinus className="h-4 w-4" />,
  status_change: <Calendar className="h-4 w-4" />,
  other: <FileText className="h-4 w-4" />,
};

const typeColors: Record<string, string> = {
  salary_change: "bg-amber-100 text-amber-800 dark:bg-amber-900 dark:text-amber-200",
  department_change: "bg-blue-100 text-blue-800 dark:bg-blue-900 dark:text-blue-200",
  position_change: "bg-purple-100 text-purple-800 dark:bg-purple-900 dark:text-purple-200",
  contract: "bg-cyan-100 text-cyan-800 dark:bg-cyan-900 dark:text-cyan-200",
  hire: "bg-green-100 text-green-800 dark:bg-green-900 dark:text-green-200",
  termination: "bg-red-100 text-red-800 dark:bg-red-900 dark:text-red-200",
  status_change: "bg-muted text-muted-foreground",
  other: "bg-muted text-muted-foreground",
};

function classifyAuditEvent(log: any): TimelineEvent | null {
  const date = log.created_at;
  const action = log.action;
  const oldVals = log.old_values || {};
  const newVals = log.new_values || {};

  if (action === "create" && log.entity_type === "employee") {
    return {
      id: log.id, date, type: "hire", title: "Employee Hired",
      description: log.changes_summary || "Employee record created",
      icon: typeIcons.hire,
    };
  }

  if (action === "update" && log.entity_type === "employee") {
    // Salary change
    if (newVals.basic_salary !== undefined && oldVals.basic_salary !== undefined && newVals.basic_salary !== oldVals.basic_salary) {
      return {
        id: log.id, date, type: "salary_change", title: "Salary Changed",
        description: `Basic salary updated`,
        oldValue: String(oldVals.basic_salary), newValue: String(newVals.basic_salary),
        icon: typeIcons.salary_change,
      };
    }
    // Department change
    if (newVals.department !== undefined && newVals.department !== oldVals.department) {
      return {
        id: log.id, date, type: "department_change", title: "Department Transfer",
        description: "Transferred to a new department",
        oldValue: oldVals.department || "None", newValue: newVals.department || "None",
        icon: typeIcons.department_change,
      };
    }
    // Position change
    if (newVals.position !== undefined && newVals.position !== oldVals.position) {
      return {
        id: log.id, date, type: "position_change", title: "Position Changed",
        description: "Job position updated",
        oldValue: oldVals.position || "None", newValue: newVals.position || "None",
        icon: typeIcons.position_change,
      };
    }
    // Active status
    if (newVals.is_active === false && oldVals.is_active === true) {
      return {
        id: log.id, date, type: "termination", title: "Employee Deactivated",
        description: log.changes_summary || "Employment ended",
        icon: typeIcons.termination,
      };
    }
    // Generic update
    return {
      id: log.id, date, type: "other", title: "Profile Updated",
      description: log.changes_summary || "Employee details updated",
      icon: typeIcons.other,
    };
  }

  // Contract events
  if (log.entity_type === "employee_contract") {
    return {
      id: log.id, date, type: "contract",
      title: action === "create" ? "Contract Created" : action === "update" ? "Contract Updated" : "Contract Event",
      description: log.changes_summary || `Contract ${action}`,
      icon: typeIcons.contract,
    };
  }

  return null;
}

export function EmployeeHistoryTimeline({ employeeId }: EmployeeHistoryTimelineProps) {
  const { currentOrg } = useOrganization();

  const { data: events = [], isLoading } = useQuery({
    queryKey: ["employee-history", employeeId, currentOrg?.id],
    queryFn: async () => {
      if (!currentOrg?.id) return [];
      const { data } = await supabase
        // SCOPE-EXEMPT: filtered by employee entity_id (PK), workspace-wide audit reads are safe
        .from("audit_logs")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("entity_id", employeeId)
        .in("entity_type", ["employee", "employee_contract"])
        .order("created_at", { ascending: false })
        .limit(50);

      if (!data) return [];
      return data.map(classifyAuditEvent).filter(Boolean) as TimelineEvent[];
    },
    enabled: !!currentOrg?.id && !!employeeId,
  });

  if (isLoading) {
    return <div className="flex justify-center py-8"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;
  }

  if (events.length === 0) {
    return (
      <Card>
        <CardContent className="py-8 text-center text-muted-foreground">
          No history events recorded yet. Changes to salary, department, position, and contracts will appear here.
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Employment History</CardTitle>
      </CardHeader>
      <CardContent>
        <div className="relative">
          {/* Vertical timeline line */}
          <div className="absolute left-4 top-0 bottom-0 w-px bg-border" />
          <div className="space-y-6">
            {events.map((event) => (
              <div key={event.id} className="relative pl-10">
                {/* Timeline dot */}
                <div className={`absolute left-2 top-1 w-5 h-5 rounded-full flex items-center justify-center ${typeColors[event.type]}`}>
                  {event.icon}
                </div>
                <div>
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-medium text-sm">{event.title}</span>
                    <Badge variant="outline" className="text-xs">{event.type.replace("_", " ")}</Badge>
                    <span className="text-xs text-muted-foreground">{format(new Date(event.date), "MMM d, yyyy 'at' h:mm a")}</span>
                  </div>
                  <p className="text-sm text-muted-foreground mt-1">{event.description}</p>
                  {event.oldValue && event.newValue && (
                    <div className="flex items-center gap-2 mt-1 text-sm">
                      <span className="text-muted-foreground line-through">{event.oldValue}</span>
                      <ArrowRight className="h-3 w-3 text-muted-foreground" />
                      <span className="font-medium">{event.newValue}</span>
                    </div>
                  )}
                </div>
              </div>
            ))}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}
