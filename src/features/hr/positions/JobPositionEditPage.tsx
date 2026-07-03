import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useJobPositions, type JobPosition } from "@/hooks/useJobPositions";
import { useToast } from "@/hooks/use-toast";
import { JobPositionRecordForm } from "./JobPositionRecordForm";

export default function JobPositionEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { positions, isLoading } = useJobPositions();
  const [notified, setNotified] = useState(false);

  const position = useMemo<JobPosition | null>(
    () => positions.find((p) => p.id === id) ?? null,
    [positions, id],
  );

  useEffect(() => {
    if (!id) {
      navigate("/hr/employees/positions", { replace: true });
      return;
    }
    if (!isLoading && !position && !notified) {
      setNotified(true);
      toast({ title: "Job position not found", variant: "destructive" });
      navigate("/hr/employees/positions", { replace: true });
    }
  }, [id, isLoading, position, notified, navigate, toast]);

  if (isLoading || !position) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <JobPositionRecordForm mode="edit" position={position} />;
}
