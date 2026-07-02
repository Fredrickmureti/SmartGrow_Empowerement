// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
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
import { Switch } from "@/components/ui/switch";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Send, Clock } from "lucide-react";
import { format } from "date-fns";
import { normalizeError } from "@/services/resilience";

interface Template {
  id: string;
  name: string;
  template_key: string;
  subject: string;
  category: string;
}

interface NewCampaignDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSuccess: () => void;
}

const audienceOptions = [
  { value: "all_users", label: "All Users" },
  { value: "trial_users", label: "Trial Users" },
  { value: "active_subscribers", label: "Active Subscribers" },
  { value: "expired_users", label: "Expired Users" },
  { value: "inactive_users", label: "Inactive Users (30+ days)" },
];

export function NewCampaignDialog({ open, onOpenChange, onSuccess }: NewCampaignDialogProps) {
  const { toast } = useToast();
  const [isLoading, setIsLoading] = useState(false);
  const [templates, setTemplates] = useState<Template[]>([]);
  
  // Form state
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [templateId, setTemplateId] = useState<string>("");
  const [targetAudience, setTargetAudience] = useState("all_users");
  const [scheduleForLater, setScheduleForLater] = useState(false);
  const [scheduledDate, setScheduledDate] = useState("");
  const [scheduledTime, setScheduledTime] = useState("");

  useEffect(() => {
    if (open) {
      fetchTemplates();
      // Reset form
      setName("");
      setDescription("");
      setTemplateId("");
      setTargetAudience("all_users");
      setScheduleForLater(false);
      setScheduledDate("");
      setScheduledTime("");
    }
  }, [open]);

  const fetchTemplates = async () => {
    const { data, error } = await supabase
      .from("platform_email_templates")
      .select("id, name, template_key, subject, category")
      .eq("is_active", true)
      .order("category", { ascending: true })
      .order("name", { ascending: true });

    if (!error && data) {
      setTemplates(data);
    }
  };

  const handleSubmit = async () => {
    if (!name.trim()) {
      toast({ title: "Campaign name is required", variant: "destructive" });
      return;
    }

    if (!templateId) {
      toast({ title: "Please select a template", variant: "destructive" });
      return;
    }

    setIsLoading(true);

    try {
      let scheduledAt: string | null = null;
      let status = "draft";

      if (scheduleForLater) {
        if (!scheduledDate || !scheduledTime) {
          toast({ title: "Please set schedule date and time", variant: "destructive" });
          setIsLoading(false);
          return;
        }
        scheduledAt = new Date(`${scheduledDate}T${scheduledTime}`).toISOString();
        status = "scheduled";
      } else {
        // Send immediately - set scheduled_at to now
        scheduledAt = new Date().toISOString();
        status = "scheduled";
      }

      const { error } = await supabase
        .from("platform_email_campaigns")
        .insert({
          name,
          description: description || null,
          template_id: templateId,
          target_audience: targetAudience,
          scheduled_at: scheduledAt,
          status,
          recipient_count: 0,
          sent_count: 0,
          failed_count: 0,
          opened_count: 0,
        });

      if (error) throw error;

      toast({
        title: scheduleForLater ? "Campaign scheduled" : "Campaign created",
        description: scheduleForLater 
          ? `Campaign will be sent on ${format(new Date(scheduledAt), "MMM d, yyyy 'at' h:mm a")}`
          : "Campaign is being processed now",
      });

      onSuccess();
      onOpenChange(false);
    } catch (error: any) {
      console.error("Error creating campaign:", error);
      toast({
        title: "Failed to create campaign",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const selectedTemplate = templates.find(t => t.id === templateId);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>Create Email Campaign</DialogTitle>
          <DialogDescription>
            Send a targeted email to a segment of your users
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Campaign Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g., February Newsletter"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description (optional)</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="Internal notes about this campaign..."
              rows={2}
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="template">Email Template</Label>
            <Select value={templateId} onValueChange={setTemplateId}>
              <SelectTrigger>
                <SelectValue placeholder="Select a template" />
              </SelectTrigger>
              <SelectContent>
                {templates.map((template) => (
                  <SelectItem key={template.id} value={template.id}>
                    <div className="flex flex-col">
                      <span>{template.name}</span>
                      <span className="text-xs text-muted-foreground">{template.category}</span>
                    </div>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            {selectedTemplate && (
              <p className="text-xs text-muted-foreground">
                Subject: {selectedTemplate.subject}
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="audience">Target Audience</Label>
            <Select value={targetAudience} onValueChange={setTargetAudience}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {audienceOptions.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    {option.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          <div className="flex items-center justify-between rounded-lg border p-4">
            <div className="space-y-0.5">
              <Label>Schedule for Later</Label>
              <p className="text-xs text-muted-foreground">
                Set a specific date and time to send
              </p>
            </div>
            <Switch
              checked={scheduleForLater}
              onCheckedChange={setScheduleForLater}
            />
          </div>

          {scheduleForLater && (
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label htmlFor="date">Date</Label>
                <Input
                  id="date"
                  type="date"
                  value={scheduledDate}
                  onChange={(e) => setScheduledDate(e.target.value)}
                  min={format(new Date(), "yyyy-MM-dd")}
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="time">Time</Label>
                <Input
                  id="time"
                  type="time"
                  value={scheduledTime}
                  onChange={(e) => setScheduledTime(e.target.value)}
                />
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={isLoading}>
            {isLoading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : scheduleForLater ? (
              <Clock className="h-4 w-4 mr-2" />
            ) : (
              <Send className="h-4 w-4 mr-2" />
            )}
            {scheduleForLater ? "Schedule Campaign" : "Send Now"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
