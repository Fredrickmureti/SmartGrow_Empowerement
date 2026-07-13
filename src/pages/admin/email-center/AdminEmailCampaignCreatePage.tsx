/**
 * AdminEmailCampaignCreatePage — workspace at
 * `/admin-management/email-center/campaigns/new`. Replaces
 * `NewCampaignDialog` per Platform Admin four-pattern rule.
 */
// @ts-nocheck - Admin tables not in auto-generated types
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
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
import { Switch } from "@/components/ui/switch";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { useToast } from "@/hooks/use-toast";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";

const LIST_PATH = "/admin-management/email-center";

interface Template {
  id: string;
  name: string;
  template_key: string;
  subject: string;
  category: string;
}

const audienceOptions = [
  { value: "all_users", label: "All Users" },
  { value: "trial_users", label: "Trial Users" },
  { value: "active_subscribers", label: "Active Subscribers" },
  { value: "expired_users", label: "Expired Users" },
  { value: "inactive_users", label: "Inactive Users (30+ days)" },
];

export default function AdminEmailCampaignCreatePage() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [templates, setTemplates] = useState<Template[]>([]);
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [targetAudience, setTargetAudience] = useState("all_users");
  const [scheduleForLater, setScheduleForLater] = useState(false);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);

  useEffect(() => {
    supabase
      .from("platform_email_templates")
      .select("id, name, template_key, subject, category")
      .eq("is_active", true)
      .order("category", { ascending: true })
      .order("name", { ascending: true })
      .then(({ data, error }) => {
        if (!error && data) setTemplates(data);
      });
  }, []);

  const selectedTemplate = templates.find((t) => t.id === templateId);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "Campaign name is required", variant: "destructive" });
      return;
    }
    if (!templateId) {
      toast({ title: "Please select a template", variant: "destructive" });
      return;
    }

    setIsSubmitting(true);
    try {
      let scheduledAt: string;
      if (scheduleForLater) {
        if (!scheduledDate || !scheduledTime) {
          toast({ title: "Please set schedule date and time", variant: "destructive" });
          setIsSubmitting(false);
          return;
        }
        scheduledAt = new Date(`${scheduledDate}T${scheduledTime}`).toISOString();
      } else {
        scheduledAt = new Date().toISOString();
      }

      const { error } = await supabase.from("platform_email_campaigns").insert({
        name,
        description: description || null,
        template_id: templateId,
        target_audience: targetAudience,
        scheduled_at: scheduledAt,
        status: "scheduled",
        recipient_count: 0,
        sent_count: 0,
        failed_count: 0,
        opened_count: 0,
      });
      if (error) throw error;

      toast({
        title: scheduleForLater ? "Campaign scheduled" : "Campaign created",
        description: scheduleForLater
          ? `Will be sent on ${format(new Date(scheduledAt), "MMM d, yyyy 'at' h:mm a")}`
          : "Campaign is being processed now",
      });
      navigate(LIST_PATH);
    } catch (err: any) {
      toast({
        title: "Failed to create campaign",
        description: normalizeError(err).message,
        variant: "destructive",
      });
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AdminRecordForm
      mode="create"
      entityLabel="Email campaign"
      meta="Send a targeted email to a segment of your users."
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={scheduleForLater ? "Schedule campaign" : "Send now"}
    >
      <Section title="Identity" description="Internal name and notes for this campaign.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="camp-name">Campaign name *</Label>
            <Input id="camp-name" value={name} onChange={(e) => setName(e.target.value)}
              placeholder="e.g., February Newsletter" required />
          </div>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="camp-desc">Description</Label>
              <Textarea id="camp-desc" value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="Internal notes about this campaign..." rows={2} />
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>

      <Section title="Template & audience" description="Choose the email template and target segment.">
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label>Template *</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger><SelectValue placeholder="Select a template" /></SelectTrigger>
              <SelectContent>
                {templates.map((t) => (
                  <SelectItem key={t.id} value={t.id}>
                    <div className="flex flex-col">
                      <span>{t.name}</span>
                      <span className="text-xs text-muted-foreground">{t.category}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTemplate && (
              <p className="text-xs text-muted-foreground">Subject: {selectedTemplate.subject}</p>
            )}
          </div>
          <div className="space-y-2">
            <Label>Target audience</Label>
            <Select value={targetAudience} onValueChange={setTargetAudience}>
              <SelectTrigger><SelectValue /></SelectTrigger>
              <SelectContent>
                {audienceOptions.map((o) => (
                  <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </AdminFieldGrid>
      </Section>

      <Section title="Schedule" description="Send immediately or schedule for later.">
        <AdminFieldCell span={2}>
          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label>Schedule for later</Label>
              <p className="text-xs text-muted-foreground">Set a specific date and time to send.</p>
            </div>
            <Switch checked={scheduleForLater} onCheckedChange={setScheduleForLater} />
          </div>
        </AdminFieldCell>
        {scheduleForLater && (
          <AdminFieldGrid columns={2}>
            <div className="space-y-2">
              <Label htmlFor="camp-date">Date</Label>
              <Input id="camp-date" type="date" value={scheduledDate}
                onChange={(e) => setScheduledDate(e.target.value)}
                min={format(new Date(), "yyyy-MM-dd")} />
            </div>
            <div className="space-y-2">
              <Label htmlFor="camp-time">Time</Label>
              <Input id="camp-time" type="time" value={scheduledTime}
                onChange={(e) => setScheduledTime(e.target.value)} />
            </div>
          </AdminFieldGrid>
        )}
      </Section>
    </AdminRecordForm>
  );
}