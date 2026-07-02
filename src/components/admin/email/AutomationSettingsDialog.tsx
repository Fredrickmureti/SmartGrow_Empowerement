// @ts-nocheck - Admin tables not in auto-generated types
import { useState } from "react";
import { supabase } from "@/integrations/supabase/client";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
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
import { useToast } from "@/hooks/use-toast";
import { Settings, Loader2, Save } from "lucide-react";
import { Json } from "@/integrations/supabase/types";
import { normalizeError } from "@/services/resilience";

interface AutomationRule {
  id: string;
  name: string;
  description: string | null;
  trigger_type: string;
  trigger_config: Json;
  action_type: string;
  template_id: string | null;
  is_active: boolean;
}

interface AutomationSettingsDialogProps {
  rule: AutomationRule;
  onUpdate: () => void;
}

export function AutomationSettingsDialog({ rule, onUpdate }: AutomationSettingsDialogProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [isLoading, setIsLoading] = useState(false);
  
  const config = (typeof rule.trigger_config === 'object' && rule.trigger_config !== null && !Array.isArray(rule.trigger_config)) 
    ? rule.trigger_config as Record<string, any>
    : {};

  const [name, setName] = useState(rule.name);
  const [description, setDescription] = useState(rule.description || "");
  const [delayMinutes, setDelayMinutes] = useState(config.delay_minutes?.toString() || "0");
  const [daysInactive, setDaysInactive] = useState(config.days_inactive?.toString() || "7");
  const [daysBefore, setDaysBefore] = useState(config.days_before?.toString() || "3");

  const handleSave = async () => {
    setIsLoading(true);
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
          triggerConfig = config;
      }

      const { error } = await supabase
        .from("platform_automation_rules")
        .update({
          name,
          description: description || null,
          trigger_config: triggerConfig,
        })
        .eq("id", rule.id);

      if (error) throw error;

      toast({ title: "Automation updated successfully" });
      onUpdate();
      setOpen(false);
    } catch (error: any) {
      toast({
        title: "Error updating automation",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const renderTriggerConfig = () => {
    switch (rule.trigger_type) {
      case "signup":
        return (
          <div className="space-y-2">
            <Label htmlFor="delay">Delay (minutes after signup)</Label>
            <Input
              id="delay"
              type="number"
              min="0"
              value={delayMinutes}
              onChange={(e) => setDelayMinutes(e.target.value)}
              placeholder="0"
            />
            <p className="text-xs text-muted-foreground">
              How long to wait after signup before sending the email. Use 0 for immediate.
            </p>
          </div>
        );
      case "inactivity":
        return (
          <div className="space-y-2">
            <Label htmlFor="daysInactive">Days of Inactivity</Label>
            <Select value={daysInactive} onValueChange={setDaysInactive}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="3">3 days</SelectItem>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
                <SelectItem value="30">30 days</SelectItem>
                <SelectItem value="60">60 days</SelectItem>
                <SelectItem value="90">90 days</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Trigger email after this many days without login activity.
            </p>
          </div>
        );
      case "trial_warning":
      case "subscription_warning":
        return (
          <div className="space-y-2">
            <Label htmlFor="daysBefore">Days Before Expiry</Label>
            <Select value={daysBefore} onValueChange={setDaysBefore}>
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectItem value="1">1 day</SelectItem>
                <SelectItem value="3">3 days</SelectItem>
                <SelectItem value="7">7 days</SelectItem>
                <SelectItem value="14">14 days</SelectItem>
              </SelectContent>
            </Select>
            <p className="text-xs text-muted-foreground">
              Send warning email this many days before expiry.
            </p>
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
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger asChild>
        <Button variant="ghost" size="icon">
          <Settings className="h-4 w-4" />
        </Button>
      </DialogTrigger>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Automation Settings</DialogTitle>
          <DialogDescription>
            Configure the automation trigger and behavior
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-4">
          <div className="space-y-2">
            <Label htmlFor="name">Name</Label>
            <Input
              id="name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Automation name"
            />
          </div>

          <div className="space-y-2">
            <Label htmlFor="description">Description</Label>
            <Textarea
              id="description"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              placeholder="What does this automation do?"
              rows={2}
            />
          </div>

          <div className="border-t pt-4">
            <h4 className="text-sm font-medium mb-3">Trigger Configuration</h4>
            {renderTriggerConfig()}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => setOpen(false)} disabled={isLoading}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={isLoading}>
            {isLoading ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Save className="h-4 w-4 mr-2" />
            )}
            Save Changes
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
