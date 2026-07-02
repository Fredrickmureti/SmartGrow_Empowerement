import { ProjectSettings } from "@/components/projects/ProjectSettings";
import { useProjects } from "@/hooks/projects";
import { useProjectWorkspace } from "./ProjectDetailLayout";

export default function SettingsTab() {
  const { project, stages, refreshProject, refreshStages } = useProjectWorkspace();
  const { updateProject } = useProjects();
  return (
    <ProjectSettings
      project={project}
      stages={stages}
      onUpdate={async (updates) => { await updateProject(project.id, updates); await refreshProject(); }}
      onStagesChange={refreshStages}
    />
  );
}
