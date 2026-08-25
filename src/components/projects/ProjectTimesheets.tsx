import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useAuth } from "@/contexts/AuthContext";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Clock, Plus } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

interface ProjectTimesheetsProps {
  projectId: string;
}

interface TimesheetEntry {
  id: string;
  date: string;
  hours: number;
  description: string | null;
  is_billable: boolean | null;
  status: string;
  billing_amount: number | null;
}

export function ProjectTimesheets({ projectId }: ProjectTimesheetsProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { user } = useAuth();
  const [entries, setEntries] = useState<TimesheetEntry[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [hours, setHours] = useState("");
  const [description, setDescription] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  const fetchTimesheets = async () => {
    if (!currentOrg) return;
    setIsLoading(true);
    try {
      let q = supabase
        .from("timesheets")
        .select("id, date, hours, description, is_billable, status, billing_amount")
        .eq("project_id", projectId)
        .eq("organization_id", currentOrg.id)
        .order("date", { ascending: false })
        .limit(100);
      q = q.eq("business_id", currentBusiness!.id);
      const { data, error } = await q;

      if (error) throw error;
      setEntries((data || []) as TimesheetEntry[]);
    } catch (error) {
      console.error("Error fetching timesheets:", error);
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchTimesheets();
  }, [projectId, currentOrg?.id]);

  const handleLogTime = async () => {
    if (!currentOrg || !user || !hours) return;
    setIsSubmitting(true);
    try {
      const scope = {
        organizationId: currentOrg.id,
        businessId: currentBusiness?.id ?? null,
        userId: user.id,
      };
      const employeeId = await resolveMyEmployeeId(scope);

      if (!employeeId) {
        toast.error("No employee record found. Set up your employee profile first.");
        return;
      }

      await insertTimesheet(scope, {
        employee_id: employeeId,
        project_id: projectId,
        date: new Date().toISOString().split("T")[0],
        hours: parseFloat(hours),
        description: description || "Project time entry",
      });

      toast.success("Time logged successfully");
      setHours("");
      setDescription("");
      setShowAdd(false);
      await fetchTimesheets();
    } catch (error) {
      console.error("Error logging time:", error);
      toast.error("Failed to log time");
    } finally {
      setIsSubmitting(false);
    }
  };


  const totalHours = entries.reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
  const billableHours = entries.filter(e => e.is_billable).reduce((sum, e) => sum + (Number(e.hours) || 0), 0);
  const totalBillingAmount = entries.reduce((sum, e) => sum + (Number(e.billing_amount) || 0), 0);

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-4">
      {/* Summary */}
      <div className="flex items-center justify-between flex-wrap gap-2">
        <div className="flex items-center gap-4 text-sm">
          <span className="flex items-center gap-1 text-muted-foreground">
            <Clock className="h-3.5 w-3.5" />
            {totalHours.toFixed(1)}h total
          </span>
          {billableHours > 0 && (
            <span className="text-muted-foreground">{billableHours.toFixed(1)}h billable</span>
          )}
          {totalBillingAmount > 0 && (
            <span className="text-muted-foreground">${totalBillingAmount.toFixed(0)} billed</span>
          )}
        </div>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Log Time
        </Button>
      </div>

      {/* Quick add form */}
      {showAdd && (
        <Card>
          <CardContent className="p-3">
            <div className="flex gap-2 items-end">
              <div className="space-y-1">
                <Label className="text-xs">Hours</Label>
                <Input
                  type="number"
                  value={hours}
                  onChange={e => setHours(e.target.value)}
                  placeholder="0.0"
                  step="0.25"
                  className="w-20"
                />
              </div>
              <div className="flex-1 space-y-1">
                <Label className="text-xs">Description</Label>
                <Input
                  value={description}
                  onChange={e => setDescription(e.target.value)}
                  placeholder="What did you work on?"
                  onKeyDown={e => e.key === "Enter" && handleLogTime()}
                />
              </div>
              <Button size="sm" onClick={handleLogTime} disabled={!hours || isSubmitting}>
                {isSubmitting ? "..." : "Log"}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Entries */}
      {entries.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8">
            <p className="text-sm text-muted-foreground">No time entries recorded for this project.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {entries.map(entry => (
                <div key={entry.id} className="flex items-center justify-between p-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm">{entry.description || "No description"}</p>
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-xs text-muted-foreground">
                        {format(new Date(entry.date), "MMM d, yyyy")}
                      </span>
                      {entry.is_billable && (
                        <span className="text-[10px] px-1 py-0.5 rounded bg-green-500/10 text-green-600">billable</span>
                      )}
                      <span className="text-[10px] px-1 py-0.5 rounded bg-muted text-muted-foreground">{entry.status}</span>
                    </div>
                  </div>
                  <span className="text-sm font-medium shrink-0">{entry.hours}h</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
