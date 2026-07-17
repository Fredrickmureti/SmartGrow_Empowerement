/**
 * LineAnalyticsCell — compact (Project + Task) picker pair for use inside a
 * line row of an Invoice / SO / PO / Bill table.
 *
 * Defaults to the parent document's `headerProjectId` so the user sees the
 * same project as the document header until they explicitly override at the
 * line. The line value still wins on the analytic posting trigger.
 */
import { ProjectPicker } from "@/components/projects/ProjectPicker";
import { TaskPicker } from "@/components/projects/TaskPicker";
import { useCapability } from "@/hooks/useCapability";

interface LineAnalyticsCellProps {
  projectId: string | null | undefined;
  taskId: string | null | undefined;
  headerProjectId?: string | null;
  customerId?: string | null;
  onChange: (next: { project_id: string | null; task_id: string | null }) => void;
  disabled?: boolean;
}

export function LineAnalyticsCell({
  projectId,
  taskId,
  headerProjectId,
  customerId,
  onChange,
  disabled,
}: LineAnalyticsCellProps) {
  // Same capability guard as ProjectPicker: without the Projects app
  // installed, no analytic tagging column should appear on line rows.
  const capability = useCapability("projects.analytic-tagging");
  const effectiveProject = projectId ?? headerProjectId ?? null;

  if (!capability.ready || !capability.available) return null;



  return (
    <div className="flex flex-col gap-1">
      <ProjectPicker
        compact
        value={effectiveProject}
        customerId={customerId ?? null}
        disabled={disabled}
        onChange={(pid) => onChange({ project_id: pid, task_id: pid !== effectiveProject ? null : taskId ?? null })}
      />
      <TaskPicker
        compact
        projectId={effectiveProject}
        value={taskId ?? null}
        disabled={disabled}
        onChange={(tid) => onChange({ project_id: effectiveProject, task_id: tid })}
      />
    </div>
  );
}
