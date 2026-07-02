import { ProjectOverview } from "@/components/projects/ProjectOverview";
import { useProjectWorkspace } from "./ProjectDetailLayout";

export default function OverviewTab() {
  const { project, tasks } = useProjectWorkspace();
  return <ProjectOverview project={project} tasks={tasks} />;
}
