import { MilestoneList } from "@/components/projects/MilestoneList";
import { useProjectWorkspace } from "./ProjectDetailLayout";

export default function MilestonesTab() {
  const { project } = useProjectWorkspace();
  return <MilestoneList projectId={project.id} />;
}
