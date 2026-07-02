import { useState, useEffect } from "react";
import { WorkflowSheet, WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Calendar } from "@/components/ui/calendar";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { CalendarIcon, Loader2, Phone, Mail, Users, Monitor, Calendar as CalendarIconAlt, CheckSquare } from "lucide-react";
import { format } from "date-fns";
import { cn } from "@/lib/utils";
import { useCRMActivityTypes } from "@/hooks/crm/useCRMActivityTypes";
import { CRMActivity } from "@/hooks/crm/useCRMActivities";

interface ScheduleActivityDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  leadId: string;
  leadName: string;
  onSchedule: (activity: Partial<CRMActivity>) => Promise<void>;
  existingActivity?: CRMActivity;
}

const ICON_MAP: Record<string, React.ReactNode> = {
  phone: <Phone className="h-4 w-4" />,
  mail: <Mail className="h-4 w-4" />,
  users: <Users className="h-4 w-4" />,
  monitor: <Monitor className="h-4 w-4" />,
  calendar: <CalendarIconAlt className="h-4 w-4" />,
  "check-square": <CheckSquare className="h-4 w-4" />,
};

export function ScheduleActivityDialog({
  open,
  onOpenChange,
  leadId,
  leadName,
  onSchedule,
  existingActivity,
}: ScheduleActivityDialogProps) {
  const { activityTypes, isLoading: typesLoading, initializeDefaultTypes } = useCRMActivityTypes();
  const [isSubmitting, setIsSubmitting] = useState(false);

  const [activityTypeId, setActivityTypeId] = useState("");
  const [summary, setSummary] = useState("");
  const [description, setDescription] = useState("");
  const [dueDate, setDueDate] = useState<Date | undefined>(new Date());
  const [dueTime, setDueTime] = useState("09:00");
  const [duration, setDuration] = useState(30);

  useEffect(() => {
    if (!typesLoading && activityTypes.length === 0 && open) {
      initializeDefaultTypes();
    }
  }, [typesLoading, activityTypes.length, open]);

  useEffect(() => {
    if (activityTypes.length > 0 && !activityTypeId) {
      setActivityTypeId(activityTypes[0].id);
    }
  }, [activityTypes, activityTypeId]);

  useEffect(() => {
    if (existingActivity) {
      setActivityTypeId(existingActivity.activity_type_id || "");
      setSummary(existingActivity.summary);
      setDescription(existingActivity.description || "");
      setDueDate(existingActivity.due_date ? new Date(existingActivity.due_date) : new Date());
      setDueTime(existingActivity.due_time || "09:00");
      setDuration(existingActivity.duration || 30);
    }
  }, [existingActivity]);

  useEffect(() => {
    const selectedType = activityTypes.find((t) => t.id === activityTypeId);
    if (selectedType?.default_duration) {
      setDuration(selectedType.default_duration);
    }
  }, [activityTypeId, activityTypes]);

  const handleSubmit = async () => {
    if (!summary.trim()) return;

    setIsSubmitting(true);
    try {
      const selectedType = activityTypes.find((t) => t.id === activityTypeId);
      await onSchedule({
        lead_id: leadId,
        activity_type_id: activityTypeId || null,
        activity_type: selectedType?.name || null,
        summary: summary.trim(),
        description: description.trim() || null,
        due_date: dueDate ? format(dueDate, "yyyy-MM-dd") : null,
        due_time: dueTime || null,
        duration: duration || null,
      });

      setSummary("");
      setDescription("");
      setDueDate(new Date());
      setDueTime("09:00");
      onOpenChange(false);
    } catch (error) {
      console.error("Failed to schedule activity:", error);
    } finally {
      setIsSubmitting(false);
    }
  };

  const selectedType = activityTypes.find((t) => t.id === activityTypeId);

  return (
    <WorkflowSheet
      open={open}
      onOpenChange={onOpenChange}
      size="md"
      title={existingActivity ? "Edit Activity" : "Schedule Activity"}
      description={existingActivity ? "Update this activity" : `Schedule a new activity for ${leadName}`}
      footer={
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isSubmitting || !summary.trim()}>
            {isSubmitting && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            {existingActivity ? "Update Activity" : "Schedule Activity"}
          </Button>
        </>
      }
    >
      <WorkflowSheetSection number={1} title="Activity type">
        {typesLoading ? (
          <div className="flex items-center justify-center py-2">
            <Loader2 className="h-4 w-4 animate-spin" />
          </div>
        ) : (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {activityTypes.map((type) => (
              <Button
                key={type.id}
                type="button"
                variant={activityTypeId === type.id ? "default" : "outline"}
                className={cn(
                  "flex items-center gap-2 h-auto py-3",
                  activityTypeId === type.id && "ring-2 ring-primary"
                )}
                style={{
                  backgroundColor: activityTypeId === type.id ? type.color || undefined : undefined,
                  borderColor: type.color || undefined,
                }}
                onClick={() => setActivityTypeId(type.id)}
              >
                {type.icon && ICON_MAP[type.icon]}
                <span className="text-sm">{type.name}</span>
              </Button>
            ))}
          </div>
        )}
      </WorkflowSheetSection>

      <WorkflowSheetSection number={2} title="Details">
        <WorkflowField label="Summary" htmlFor="summary" required>
          <Input
            id="summary"
            placeholder={`e.g., Follow up on ${selectedType?.name || "activity"}...`}
            value={summary}
            onChange={(e) => setSummary(e.target.value)}
          />
        </WorkflowField>

        <WorkflowSheetGrid>
          <WorkflowField label="Due Date">
            <Popover>
              <PopoverTrigger asChild>
                <Button
                  variant="outline"
                  className={cn(
                    "w-full justify-start text-left font-normal",
                    !dueDate && "text-muted-foreground"
                  )}
                >
                  <CalendarIcon className="mr-2 h-4 w-4" />
                  {dueDate ? format(dueDate, "PPP") : "Pick a date"}
                </Button>
              </PopoverTrigger>
              <PopoverContent className="w-auto p-0">
                <Calendar
                  mode="single"
                  selected={dueDate}
                  onSelect={setDueDate}
                  initialFocus
                />
              </PopoverContent>
            </Popover>
          </WorkflowField>

          <WorkflowField label="Time" htmlFor="time">
            <Input
              id="time"
              type="time"
              value={dueTime}
              onChange={(e) => setDueTime(e.target.value)}
            />
          </WorkflowField>
        </WorkflowSheetGrid>

        <WorkflowField label="Duration (minutes)" htmlFor="duration">
          <Select value={duration.toString()} onValueChange={(v) => setDuration(parseInt(v))}>
            <SelectTrigger>
              <SelectValue placeholder="Select duration" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="15">15 minutes</SelectItem>
              <SelectItem value="30">30 minutes</SelectItem>
              <SelectItem value="45">45 minutes</SelectItem>
              <SelectItem value="60">1 hour</SelectItem>
              <SelectItem value="90">1.5 hours</SelectItem>
              <SelectItem value="120">2 hours</SelectItem>
            </SelectContent>
          </Select>
        </WorkflowField>

        <WorkflowField label="Notes (optional)" htmlFor="description">
          <Textarea
            id="description"
            placeholder="Add any notes or agenda items..."
            value={description}
            onChange={(e) => setDescription(e.target.value)}
            rows={3}
          />
        </WorkflowField>
      </WorkflowSheetSection>
    </WorkflowSheet>
  );
}
