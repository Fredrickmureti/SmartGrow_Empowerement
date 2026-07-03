/**
 * WorkLocationRecordForm — shared create/edit form for Work Locations,
 * mounted on `RecordFormShell`. Replaces the legacy `WorkflowSheet` side
 * drawer in `src/pages/hr/WorkLocations.tsx`.
 */
import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import {
  RecordFormShell,
  Section,
  FieldGrid,
} from "@/design-system";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  useWorkLocations,
  type WorkLocation,
  type WorkLocationType,
} from "@/hooks/useWorkLocations";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

interface WorkLocationRecordFormProps {
  mode: "create" | "edit";
  location?: WorkLocation | null;
}

export function WorkLocationRecordForm({ mode, location }: WorkLocationRecordFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { create, update } = useWorkLocations();

  const [formData, setFormData] = useState({
    name: location?.name ?? "",
    location_type: (location?.location_type ?? "office") as WorkLocationType,
    address: location?.address ?? "",
    is_active: location?.is_active ?? true,
  });
  const [isSubmitting, setIsSubmitting] = useState(false);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!formData.name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      const payload = {
        name: formData.name.trim(),
        location_type: formData.location_type,
        address: formData.address.trim() || null,
        is_active: formData.is_active,
      };
      if (mode === "edit" && location) {
        await update(location.id, payload as any);
      } else {
        await create(payload as any);
      }
      navigate("/hr/employees/locations");
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <RecordFormShell
      mode={mode}
      entityLabel="Work Location"
      recordRef={location?.name}
      meta={
        mode === "edit"
          ? location?.name
          : "A physical or virtual place where people work. Separate from legal branches."
      }
      cancelHref="/hr/employees/locations"
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={mode === "edit" ? "Save changes" : "Create Location"}
    >
      <Section title="Identity" description="How this location appears across HR and Attendance.">
        <FieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="name">Name *</Label>
            <Input
              id="name"
              value={formData.name}
              onChange={(e) => setFormData({ ...formData, name: e.target.value })}
              placeholder="e.g. Nairobi HQ"
              required
            />
          </div>
          <div className="space-y-2">
            <Label htmlFor="location_type">Type</Label>
            <Select
              value={formData.location_type}
              onValueChange={(v) =>
                setFormData({ ...formData, location_type: v as WorkLocationType })
              }
            >
              <SelectTrigger id="location_type"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="office">Office</SelectItem>
                <SelectItem value="remote">Remote</SelectItem>
                <SelectItem value="other">Other</SelectItem>
              </SelectContent>
            </Select>
          </div>
        </FieldGrid>
      </Section>

      <Section title="Address" description="Used for compliance reporting and travel context.">
        <div className="space-y-2">
          <Label htmlFor="address">Street address</Label>
          <Input
            id="address"
            value={formData.address}
            onChange={(e) => setFormData({ ...formData, address: e.target.value })}
            placeholder="123 Main St, Nairobi, KE"
          />
        </div>
      </Section>
    </RecordFormShell>
  );
}
