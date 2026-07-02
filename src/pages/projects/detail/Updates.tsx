import { ProjectUpdates } from "@/components/projects/ProjectUpdates";
import { useProjectWorkspace } from "./ProjectDetailLayout";

export default function UpdatesTab() {
  const { project } = useProjectWorkspace();
  return <ProjectUpdates projectId={project.id} />;
}
