import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useWorkLocations, type WorkLocation } from "@/hooks/useWorkLocations";
import { useToast } from "@/hooks/use-toast";
import { WorkLocationRecordForm } from "./WorkLocationRecordForm";

export default function WorkLocationEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { locations, isLoading } = useWorkLocations();
  const [notified, setNotified] = useState(false);

  const location = useMemo<WorkLocation | null>(
    () => locations.find((l) => l.id === id) ?? null,
    [locations, id],
  );

  useEffect(() => {
    if (!id) {
      navigate("/hr/employees/locations", { replace: true });
      return;
    }
    if (!isLoading && !location && !notified) {
      setNotified(true);
      toast({ title: "Work location not found", variant: "destructive" });
      navigate("/hr/employees/locations", { replace: true });
    }
  }, [id, isLoading, location, notified, navigate, toast]);

  if (isLoading || !location) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <WorkLocationRecordForm mode="edit" location={location} />;
}
