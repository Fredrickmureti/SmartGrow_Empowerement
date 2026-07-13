// @ts-nocheck - Admin tables not in auto-generated types
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { Section } from "@/design-system";
import {
  AdminRecordForm,
  AdminFieldGrid,
  AdminFieldCell,
} from "@/apps/platform-admin";
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
import { Loader2 } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { normalizeError } from "@/services/resilience";

const LIST_PATH = "/admin-management/email-center";

interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: Record<string, any> | null;
  action_type: string;
}

export default function AdminEmailAutomationEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { toast } = useToast();

  const [rule, setRule] = useState<AutomationRule | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [delayMinutes, setDelayMinutes] = useState("0");
  const [daysInactive, setDaysInactive] = useState("7");
  const [daysBefore, setDaysBefore] = useState("3");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    if (!id) return;
    supabase
      .from("platform_automation_rules")
      .select("*")
      .eq("id", id)
      .maybeSingle()
      .then(({ data }) => {
        if (data) {
          const r = data as AutomationRule;
          const cfg =
            r.trigger_config && typeof r.trigger_config === "object" && !Array.isArray(r.trigger_config)
              ? (r.trigger_config as Record<string, any>)
              : {};
          setRule(r);
          setName(r.name);
          setDescription(r.description ?? "");
          setDelayMinutes(cfg.delay_minutes?.toString() ?? "0");
          setDaysInactive(cfg.days_inactive?.toString() ?? "7");
          setDaysBefore(cfg.days_before?.toString() ?? "3");
        }
        setIsLoading(false);
      });
  }, [id]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!rule) return;
    setIsSubmitting(true);
    try {
      let triggerConfig: Record<string, any> = {};
      switch (rule.trigger_type) {
        case "signup":
          triggerConfig = { delay_minutes: parseInt(delayMinutes) || 0 };
          break;
        case "inactivity":
          triggerConfig = { days_inactive: parseInt(daysInactive) || 7 };
          break;
        case "trial_warning":
        case "subscription_warning":
          triggerConfig = { days_before: parseInt(daysBefore) || 3 };
          break;
        default:
          triggerConfig = rule.trigger_config || {};
      }
      const { error } = await supabase
        .from("platform_automation_rules")
        .update({ name, description: description || null, trigger_config: triggerConfig })
        .eq("id", rule.id);
      if (error) throw error;
      toast({ title: "Automation updated" });
      navigate(LIST_PATH);
    } catch (err: any) {
      toast({
        title: "Error updating automation",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-24">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }
  if (!rule) {
    return <div className="p-8 text-sm text-muted-foreground">Automation rule not found.</div>;
  }

  const renderTriggerConfig = () => {
    switch (rule.trigger_type) {
      case "signup":
        return (
          <div className="space-y-2">
            <Label htmlFor="delay">Delay (minutes after signup)</Label>
            <Input id="delay" type="number" min="0" value={delayMinutes}
              onChange={(e) => setDelayMinutes(e.target.value)} placeholder="0" />
            <p className="text-xs text-muted-foreground">
              How long to wait after signup. Use 0 for immediate.
            </p>
          </div>
        );
      case "inactivity":
        return (
          <div className="space-y-2">
            <Label>Days of inactivity</Label>
            <Select value={daysInactive} onValueChange={setDaysInactive}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["3","7","14","30","60","90"].map(d => (
                  <SelectItem key={d} value={d}>{d} days</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      case "trial_warning":
      case "subscription_warning":
        return (
          <div className="space-y-2">
            <Label>Days before expiry</Label>
            <Select value={daysBefore} onValueChange={setDaysBefore}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {["1","3","7","14"].map(d => (
                  <SelectItem key={d} value={d}>{d} day{d === "1" ? "" : "s"}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        );
      default:
        return (
          <p className="text-sm text-muted-foreground">
            This automation type has no configurable settings.
          </p>
        );
    }
  };

  return (
    <AdminRecordForm
      mode="edit"
      entityLabel="Automation"
      recordRef={rule.name}
      meta="Configure the automation trigger and behavior."
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Save changes"
    >
      <Section title="Identity" description="Internal name and description.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="auto-name">Name</Label>
            <Input id="auto-name" value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="auto-desc">Description</Label>
              <Textarea id="auto-desc" value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What does this automation do?" rows={2} />
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>

      <Section title="Trigger configuration" description="Fine-tune when this automation fires.">
        <AdminFieldCell span={2}>{renderTriggerConfig()}</AdminFieldCell>
      </Section>
    </AdminRecordForm>
  );
}