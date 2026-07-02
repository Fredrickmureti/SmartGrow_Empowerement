import { ProjectFinancials } from "@/components/projects/ProjectFinancials";
import { RunProjectReportButton } from "@/components/projects/RunProjectReportButton";
import { useProjectWorkspace } from "./ProjectDetailLayout";

export default function FinancialsTab() {
  const { project } = useProjectWorkspace();
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <RunProjectReportButton
          projectId={project.id}
          reportType="project_profitability"
          title={`Profitability — ${project.name}`}
        />
      </div>
      <ProjectFinancials project={project} />
    </div>
  );
}
