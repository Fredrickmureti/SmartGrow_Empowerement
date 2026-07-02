import { ProjectTimesheets } from "@/components/projects/ProjectTimesheets";
import { RunProjectReportButton } from "@/components/projects/RunProjectReportButton";
import { useProjectWorkspace } from "./ProjectDetailLayout";

export default function TimesheetsTab() {
  const { project } = useProjectWorkspace();
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <RunProjectReportButton
          projectId={project.id}
          reportType="project_timesheet_detail"
          title={`Timesheets — ${project.name}`}
        />
      </div>
      <ProjectTimesheets projectId={project.id} />
    </div>
  );
}
