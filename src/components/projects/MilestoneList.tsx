import { useState, useEffect } from "react";
import { useProjects, ProjectMilestone } from "@/hooks/projects";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { CheckCircle2, Circle, Plus, Calendar } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";
import { BillMilestoneButton } from "./BillMilestoneButton";

interface MilestoneListProps {
  projectId: string;
}

export function MilestoneList({ projectId }: MilestoneListProps) {
  const { getProjectMilestones, createMilestone, completeMilestone } = useProjects();
  const [milestones, setMilestones] = useState<ProjectMilestone[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [newName, setNewName] = useState("");

  const fetchMilestones = async () => {
    setIsLoading(true);
    const data = await getProjectMilestones(projectId);
    setMilestones(data);
    setIsLoading(false);
  };

  useEffect(() => {
    fetchMilestones();
  }, [projectId]);

  const handleAdd = async () => {
    if (!newName.trim()) return;
    try {
      await createMilestone(projectId, {
        name: newName,
        description: null,
        deadline: null,
        is_reached: false,
        reached_at: null,
        sequence: milestones.length,
      });
      setNewName("");
      setShowAdd(false);
      await fetchMilestones();
    } catch (error) {
      toast.error("Failed to create milestone");
    }
  };

  // The hook surfaces its own error toast; refresh either way so the row
  // reflects the server's view of the milestone.
  const handleToggle = async (milestone: ProjectMilestone) => {
    if ((milestone as { is_invoiced?: boolean }).is_invoiced) return;
    try {
      await completeMilestone(milestone.id, !milestone.is_reached);
    } catch {
      /* handled in useProjects */
    }
    await fetchMilestones();
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center h-32">
        <div className="animate-spin rounded-full h-6 w-6 border-b-2 border-primary" />
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between">
        <h3 className="text-sm font-semibold">Milestones</h3>
        <Button size="sm" variant="outline" onClick={() => setShowAdd(!showAdd)}>
          <Plus className="h-3.5 w-3.5 mr-1" />
          Add
        </Button>
      </div>

      {showAdd && (
        <div className="flex gap-2">
          <Input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="Milestone name..."
            onKeyDown={(e) => e.key === "Enter" && handleAdd()}
          />
          <Button size="sm" onClick={handleAdd} disabled={!newName.trim()}>
            Add
          </Button>
        </div>
      )}

      {milestones.length === 0 ? (
        <Card>
          <CardContent className="flex flex-col items-center justify-center py-8">
            <p className="text-sm text-muted-foreground">No milestones yet.</p>
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="p-0">
            <div className="divide-y">
              {milestones.map(m => {
                const isInvoiced = Boolean((m as unknown as { is_invoiced?: boolean }).is_invoiced);
                return (
                <div key={m.id} className="flex items-center gap-3 p-3">
                  <button
                    onClick={() => handleToggle(m)}
                    disabled={isInvoiced}
                    className="shrink-0 disabled:cursor-not-allowed"
                    title={
                      isInvoiced
                        ? "Invoiced milestones cannot be reopened"
                        : m.is_reached
                          ? "Reopen milestone"
                          : "Mark milestone reached"
                    }
                    aria-label={m.is_reached ? `Reopen ${m.name}` : `Mark ${m.name} reached`}
                  >
                    {m.is_reached ? (
                      <CheckCircle2 className="h-5 w-5 text-green-500" />
                    ) : (
                      <Circle className="h-5 w-5 text-muted-foreground hover:text-primary transition-colors" />
                    )}
                  </button>
                  <div className="flex-1 min-w-0">
                    <span className={`text-sm font-medium ${m.is_reached ? "line-through text-muted-foreground" : ""}`}>
                      {m.name}
                    </span>
                  </div>
                  {m.deadline && (
                    <span className="text-xs text-muted-foreground flex items-center gap-1">
                      <Calendar className="h-3 w-3" />
                      {format(new Date(m.deadline), "MMM d")}
                    </span>
                  )}
                  {m.is_reached && (
                    <Badge variant="secondary" className="text-xs">Done</Badge>
                  )}
                  <BillMilestoneButton
                    milestoneId={m.id}
                    isInvoiced={isInvoiced}
                    isReached={Boolean(m.is_reached)}
                    hasBillingAmount={Number((m as unknown as { billing_amount?: number | null }).billing_amount ?? 0) > 0}
                    onInvoiced={fetchMilestones}
                  />
                </div>
                );
              })
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
