import { ProjectDocuments } from "@/components/projects/ProjectDocuments";
import { useProjectWorkspace } from "./ProjectDetailLayout";

export default function DocumentsTab() {
  const { project } = useProjectWorkspace();
  return <ProjectDocuments projectId={project.id} />;
}
