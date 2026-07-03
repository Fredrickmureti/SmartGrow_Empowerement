import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Loader2 } from "lucide-react";
import { useDepartments, type Department } from "@/hooks/useDepartments";
import { useToast } from "@/hooks/use-toast";
import { DepartmentRecordForm } from "./DepartmentRecordForm";

export default function DepartmentEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();
  const { departments, isLoading } = useDepartments();
  const [notified, setNotified] = useState(false);

  const department = useMemo<Department | null>(
    () => departments.find((d) => d.id === id) ?? null,
    [departments, id],
  );

  useEffect(() => {
    if (!id) {
      navigate("/hr/employees/departments", { replace: true });
      return;
    }
    if (!isLoading && !department && !notified) {
      setNotified(true);
      toast({ title: "Department not found", variant: "destructive" });
      navigate("/hr/employees/departments", { replace: true });
    }
  }, [id, isLoading, department, notified, navigate, toast]);

  if (isLoading || !department) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return <DepartmentRecordForm mode="edit" department={department} />;
}
