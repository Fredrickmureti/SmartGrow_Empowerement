// @ts-nocheck - Admin tables not in auto-generated types
import { useState, useEffect } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { useToast } from "@/hooks/use-toast";
import { Zap, Loader2, Play, Mail, UserPlus, Clock, AlertTriangle, CreditCard } from "lucide-react";
import { format } from "date-fns";
import { Json } from "@/integrations/supabase/types";
import { AutomationSettingsDialog } from "./AutomationSettingsDialog";
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
  last_run_at: string | null;
  run_count: number;
  created_at: string;
}

const triggerIcons: Record<string, React.ReactNode> = {
  signup: <UserPlus className="h-4 w-4" />,
  inactivity: <Clock className="h-4 w-4" />,
  manual: <Play className="h-4 w-4" />,
  trial_warning: <AlertTriangle className="h-4 w-4" />,
  trial_expired: <AlertTriangle className="h-4 w-4" />,
  subscription_warning: <CreditCard className="h-4 w-4" />,
  subscription_expired: <CreditCard className="h-4 w-4" />,
};

const triggerLabels: Record<string, string> = {
  signup: "New Signup",
  inactivity: "User Inactivity",
  manual: "Manual Trigger",
  trial_warning: "Trial Warning",
  trial_expired: "Trial Expired",
  subscription_warning: "Subscription Warning",
  subscription_expired: "Subscription Expired",
};

export function EmailAutomationsTab() {
  const { toast } = useToast();
  const [automations, setAutomations] = useState<AutomationRule[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [togglingId, setTogglingId] = useState<string | null>(null);

  useEffect(() => {
    fetchAutomations();
  }, []);

  const fetchAutomations = async () => {
    try {
      const { data, error } = await supabase
        .from("platform_automation_rules")
        .select("*")
        .order("priority", { ascending: true })
        .order("name", { ascending: true });

      if (error) throw error;
      setAutomations(data || []);
    } catch (error) {
      console.error("Error fetching automations:", error);
      toast({
        title: "Error",
        description: "Failed to load automations",
        variant: "destructive",
      });
    } finally {
      setIsLoading(false);
    }
  };

  const handleToggle = async (id: string, currentState: boolean) => {
    setTogglingId(id);
    try {
      const { error } = await supabase
        .from("platform_automation_rules")
        .update({ is_active: !currentState })
        .eq("id", id);

      if (error) throw error;
      
      setAutomations(prev =>
        prev.map(a => a.id === id ? { ...a, is_active: !currentState } : a)
      );
      
      toast({
        title: `Automation ${!currentState ? "enabled" : "disabled"}`,
      });
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message || "Failed to toggle automation",
        variant: "destructive",
      });
    } finally {
      setTogglingId(null);
    }
  };

  const getTriggerDescription = (rule: AutomationRule): string => {
    const config = (typeof rule.trigger_config === 'object' && rule.trigger_config !== null && !Array.isArray(rule.trigger_config)) 
      ? rule.trigger_config as Record<string, any>
      : {};
    switch (rule.trigger_type) {
      case "signup":
        const delay = config.delay_minutes || 0;
        return delay === 0 ? "Send immediately after signup" : `Send ${delay} minutes after signup`;
      case "inactivity":
        return `Trigger after ${config.days_inactive || 7} days of inactivity`;
      case "trial_warning":
        return `Send ${config.days_before || 3} days before trial ends`;
      case "trial_expired":
        return "Send when trial has expired";
      case "subscription_warning":
        return `Send ${config.days_before || 7} days before subscription ends`;
      case "subscription_expired":
        return "Send when subscription has expired";
      case "manual":
        return "Triggered manually by admin";
      default:
        return rule.trigger_type;
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <div className="flex items-center justify-between">
            <div>
              <CardTitle className="text-base flex items-center gap-2">
                <Zap className="h-5 w-5" />
                Email Automations
              </CardTitle>
              <CardDescription>
                Automatically send emails based on user behavior and triggers
              </CardDescription>
            </div>
            <Badge variant="outline">
              {automations.filter(a => a.is_active).length} Active
            </Badge>
          </div>
        </CardHeader>
        <CardContent>
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Automation</TableHead>
                <TableHead>Trigger</TableHead>
                <TableHead>Action</TableHead>
                <TableHead>Runs</TableHead>
                <TableHead>Last Run</TableHead>
                <TableHead>Active</TableHead>
                <TableHead className="text-right">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {automations.map((rule) => (
                <TableRow key={rule.id}>
                  <TableCell>
                    <div>
                      <p className="font-medium">{rule.name}</p>
                      <p className="text-xs text-muted-foreground">{rule.description}</p>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      {triggerIcons[rule.trigger_type]}
                      <div>
                        <p className="text-sm">{triggerLabels[rule.trigger_type] || rule.trigger_type}</p>
                        <p className="text-xs text-muted-foreground">{getTriggerDescription(rule)}</p>
                      </div>
                    </div>
                  </TableCell>
                  <TableCell>
                    <div className="flex items-center gap-2">
                      <Mail className="h-4 w-4 text-muted-foreground" />
                      <span className="text-sm capitalize">{rule.action_type.replace("_", " ")}</span>
                    </div>
                  </TableCell>
                  <TableCell className="font-medium">{rule.run_count}</TableCell>
                  <TableCell className="text-sm text-muted-foreground">
                    {rule.last_run_at
                      ? format(new Date(rule.last_run_at), "MMM d, h:mm a")
                      : "Never"}
                  </TableCell>
                  <TableCell>
                    <Switch
                      checked={rule.is_active}
                      onCheckedChange={() => handleToggle(rule.id, rule.is_active)}
                      disabled={togglingId === rule.id}
                    />
                  </TableCell>
                  <TableCell className="text-right">
                    <AutomationSettingsDialog 
                      rule={rule} 
                      onUpdate={fetchAutomations} 
                    />
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
