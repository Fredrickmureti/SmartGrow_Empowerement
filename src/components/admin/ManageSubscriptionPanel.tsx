// @ts-nocheck - Admin tables not in auto-generated types
/**
 * ManageSubscriptionPanel — the shared body used by the Manage
 * Subscription workspace route
 * (`/admin-management/organizations/:id/subscription`). Extracted from
 * the retired `ManageSubscriptionDialog` so the same subscription
 * lifecycle form now lives inside a proper record workspace instead of
 * a modal.
 *
 * See `docs/design-system/audit/platform-admin.md`.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { useAuth } from "@/contexts/AuthContext";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import {
  Loader2,
  Calendar,
  AlertCircle,
  Clock,
  CheckCircle,
  Plus,
  DollarSign,
} from "lucide-react";
import { format, addDays, addMonths, differenceInDays } from "date-fns";
import { Separator } from "@/components/ui/separator";
import { Textarea } from "@/components/ui/textarea";
import { normalizeError } from "@/services/resilience";

interface SubscriptionPlan {
  id: string;
  name: string;
  price_monthly: number;
  price_yearly: number;
  billing_period?: string;
  billing_period_days?: number;
}

export interface ManageSubscriptionOrganization {
  id: string;
  name: string;
  subscription_plan_id?: string | null;
  subscription_status?: string | null;
  subscription_started_at?: string | null;
  subscription_ends_at?: string | null;
  trial_ends_at?: string | null;
  is_suspended?: boolean;
}

interface ManageSubscriptionPanelProps {
  organization: ManageSubscriptionOrganization | null;
  /** Called after a successful save. */
  onSaved?: () => void;
  /** Called when the user hits Cancel. */
  onCancel?: () => void;
  /** Footer variant — "inline" for full-page shells (renders no sticky
   * footer; parent supplies FooterActionBar), "attached" for embedded
   * usage (renders its own Cancel / Save row). */
  footer?: "inline" | "attached";
  /** Bound externally so a parent FooterActionBar can drive the submit. */
  formId?: string;
}

const SUBSCRIPTION_STATUSES = [
  { value: "trial", label: "Trial", color: "bg-blue-500/10 text-blue-600", icon: Clock },
  { value: "active", label: "Active", color: "bg-green-500/10 text-green-600", icon: CheckCircle },
  { value: "past_due", label: "Past Due", color: "bg-yellow-500/10 text-yellow-600", icon: AlertCircle },
  { value: "expired", label: "Expired", color: "bg-orange-500/10 text-orange-600", icon: AlertCircle },
  { value: "cancelled", label: "Cancelled", color: "bg-gray-500/10 text-gray-600", icon: AlertCircle },
  { value: "suspended", label: "Suspended", color: "bg-red-500/10 text-red-600", icon: AlertCircle },
];

const DURATION_OPTIONS = [
  { value: "1_month", label: "1 Month", days: 30 },
  { value: "3_months", label: "3 Months", days: 90 },
  { value: "6_months", label: "6 Months", days: 180 },
  { value: "12_months", label: "12 Months (1 Year)", days: 365 },
  { value: "custom", label: "Custom Date", days: 0 },
];

export function ManageSubscriptionPanel({
  organization,
  onSaved,
  onCancel,
  footer = "attached",
  formId = "manage-subscription-form",
}: ManageSubscriptionPanelProps) {
  const { toast } = useToast();
  const { user } = useAuth();
  const { formatCurrency } = useAdminCurrency();
  const [isLoading, setIsLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [plans, setPlans] = useState<SubscriptionPlan[]>([]);

  const [selectedPlanId, setSelectedPlanId] = useState<string>("");
  const [status, setStatus] = useState<string>("trial");
  const [trialEndsAt, setTrialEndsAt] = useState<string>("");
  const [subscriptionEndsAt, setSubscriptionEndsAt] = useState<string>("");
  const [selectedDuration, setSelectedDuration] = useState<string>("1_month");
  const [paymentMethod, setPaymentMethod] = useState<string>("cash");
  const [paymentAmount, setPaymentAmount] = useState<string>("");
  const [paymentNotes, setPaymentNotes] = useState<string>("");
  const [recordPayment, setRecordPayment] = useState(false);
  const [downgradeWarning, setDowngradeWarning] = useState<string | null>(null);

  useEffect(() => {
    if (!selectedPlanId || !organization?.subscription_plan_id || selectedPlanId === organization.subscription_plan_id) {
      setDowngradeWarning(null);
      return;
    }
    async function checkDowngrade() {
      const [currentApps, newApps] = await Promise.all([
        (supabase as any).from("plan_app_access").select("app_id").eq("plan_id", organization.subscription_plan_id).eq("is_included", true),
        (supabase as any).from("plan_app_access").select("app_id").eq("plan_id", selectedPlanId).eq("is_included", true),
      ]);
      const currentSet = new Set((currentApps.data || []).map((a: any) => a.app_id));
      const newSet = new Set((newApps.data || []).map((a: any) => a.app_id));
      const lost: string[] = [];
      currentSet.forEach((id: string) => { if (!newSet.has(id)) lost.push(id); });
      if (lost.length > 0) {
        setDowngradeWarning(`This is a downgrade. The organization will lose access to ${lost.length} app(s). Their data will be preserved but inaccessible until they upgrade again.`);
      } else {
        setDowngradeWarning(null);
      }
    }
    checkDowngrade();
  }, [selectedPlanId, organization?.subscription_plan_id]);

  useEffect(() => {
    fetchPlans();
    if (organization) {
      setSelectedPlanId(organization.subscription_plan_id || "");
      setStatus(organization.subscription_status || "trial");
      setTrialEndsAt(organization.trial_ends_at ? format(new Date(organization.trial_ends_at), "yyyy-MM-dd") : "");
      setSubscriptionEndsAt(organization.subscription_ends_at ? format(new Date(organization.subscription_ends_at), "yyyy-MM-dd") : "");
      setRecordPayment(false);
      setPaymentNotes("");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [organization?.id]);

  useEffect(() => {
    if (selectedDuration !== "custom" && status === "active") {
      const duration = DURATION_OPTIONS.find(d => d.value === selectedDuration);
      if (duration && duration.days > 0) {
        const now = new Date();
        const currentEnd = subscriptionEndsAt ? new Date(subscriptionEndsAt) : now;
        const base = currentEnd > now ? currentEnd : now;
        const newEndDate = addDays(base, duration.days);
        setSubscriptionEndsAt(format(newEndDate, "yyyy-MM-dd"));
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedDuration, status]);

  useEffect(() => {
    const plan = plans.find(p => p.id === selectedPlanId);
    if (plan && recordPayment) {
      if (selectedDuration === "12_months") {
        setPaymentAmount(plan.price_yearly?.toString() || (plan.price_monthly * 12).toString());
      } else {
        const months = DURATION_OPTIONS.find(d => d.value === selectedDuration)?.days || 30;
        const monthCount = Math.ceil(months / 30);
        setPaymentAmount((plan.price_monthly * monthCount).toString());
      }
    }
  }, [selectedPlanId, selectedDuration, recordPayment, plans]);

  const fetchPlans = async () => {
    setIsLoading(true);
    try {
      const { data, error } = await (supabase.from as any)("platform_subscription_plans")
        .select("*")
        .eq("is_active", true)
        .order("price_monthly", { ascending: true });
      if (error) throw error;
      setPlans((data as any[]) || []);
    } catch (error) {
      console.error("Error fetching plans:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const handleQuickExtend = (months: number) => {
    const currentEnd = subscriptionEndsAt ? new Date(subscriptionEndsAt) : new Date();
    const newEnd = addMonths(currentEnd > new Date() ? currentEnd : new Date(), months);
    setSubscriptionEndsAt(format(newEnd, "yyyy-MM-dd"));
    setSelectedDuration("custom");
  };

  const handleActivateNow = () => {
    setStatus("active");
    setSelectedDuration("1_month");
    const newEndDate = addDays(new Date(), 30);
    setSubscriptionEndsAt(format(newEndDate, "yyyy-MM-dd"));
    setRecordPayment(true);
  };

  const handleSave = async (e?: React.FormEvent) => {
    e?.preventDefault();
    if (!organization) return;

    setIsSaving(true);
    try {
      const updateData: Record<string, any> = {
        subscription_plan_id: selectedPlanId || null,
        subscription_status: status,
        trial_ends_at: trialEndsAt ? new Date(trialEndsAt).toISOString() : null,
        subscription_ends_at: subscriptionEndsAt ? new Date(subscriptionEndsAt).toISOString() : null,
        updated_at: new Date().toISOString(),
      };
      if (status === "active" && !organization.subscription_started_at) {
        updateData.subscription_started_at = new Date().toISOString();
      }
      if (status === "active") {
        updateData.trial_ends_at = null;
      }
      const { data: updateResult, error } = await (supabase.from as any)("organizations")
        .update(updateData)
        .eq("id", organization.id)
        .select()
        .single();
      if (error) throw error;
      if (updateResult.subscription_plan_id !== (selectedPlanId || null) ||
          updateResult.subscription_status !== status) {
        throw new Error("Update failed: Changes were not applied. You may not have permission to update this organization.");
      }
      if (recordPayment && paymentAmount && parseFloat(paymentAmount) > 0) {
        const { error: paymentError } = await (supabase.from as any)("subscription_payments")
          .insert({
            organization_id: organization.id,
            plan_id: selectedPlanId || null,
            amount: parseFloat(paymentAmount),
            currency: "USD",
            payment_method: paymentMethod,
            period_start: new Date().toISOString(),
            period_end: subscriptionEndsAt ? new Date(subscriptionEndsAt).toISOString() : new Date().toISOString(),
            status: "completed",
            notes: paymentNotes || null,
            recorded_by: user?.id,
          });
        if (paymentError) {
          console.error("Error recording payment:", paymentError);
          toast({
            title: "Warning",
            description: "Subscription updated but payment recording failed: " + paymentError.message,
            variant: "destructive",
          });
        }
      }
      const planName = plans.find(p => p.id === selectedPlanId)?.name || "None";
      toast({
        title: "Subscription updated successfully",
        description: `${organization.name} is now on ${planName} plan with ${status} status.`,
      });
      onSaved?.();
    } catch (error: any) {
      console.error("Error updating subscription:", error);
      toast({
        title: "Error updating subscription",
        description: normalizeError(error).message || "Failed to update subscription. Please check your permissions.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const selectedPlan = plans.find((p) => p.id === selectedPlanId);
  const currentStatusConfig = SUBSCRIPTION_STATUSES.find((s) => s.value === status);

  const getDaysRemaining = () => {
    if (status === "trial" && trialEndsAt) {
      return differenceInDays(new Date(trialEndsAt), new Date());
    }
    if (subscriptionEndsAt) {
      return differenceInDays(new Date(subscriptionEndsAt), new Date());
    }
    return null;
  };
  const daysRemaining = getDaysRemaining();

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <form id={formId} onSubmit={handleSave} className="space-y-6">
      {/* Current Status */}
      <div className="flex items-center justify-between p-4 rounded-lg bg-muted/50 border">
        <div className="flex items-center gap-3">
          {currentStatusConfig && (
            <div className={`p-2 rounded-full ${currentStatusConfig.color}`}>
              <currentStatusConfig.icon className="h-4 w-4" />
            </div>
          )}
          <div>
            <p className="font-medium">Current Status</p>
            <p className="text-sm text-muted-foreground">
              {currentStatusConfig?.label || "Unknown"}
              {daysRemaining !== null && daysRemaining > 0 && (
                <span className="ml-2 text-primary">({daysRemaining} days remaining)</span>
              )}
              {daysRemaining !== null && daysRemaining <= 0 && (
                <span className="ml-2 text-destructive">(Expired)</span>
              )}
            </p>
          </div>
        </div>
        {status !== "active" && (
          <Button type="button" variant="default" size="sm" onClick={handleActivateNow}>
            <CheckCircle className="h-4 w-4 mr-1" /> Activate Now
          </Button>
        )}
      </div>

      {/* Quick actions */}
      <div className="space-y-2">
        <Label className="text-sm font-medium">Quick Actions</Label>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => handleQuickExtend(1)}>
            <Plus className="h-3 w-3 mr-1" /> +1 Month
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => handleQuickExtend(3)}>
            <Plus className="h-3 w-3 mr-1" /> +3 Months
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => handleQuickExtend(12)}>
            <Plus className="h-3 w-3 mr-1" /> +12 Months
          </Button>
        </div>
      </div>

      <Separator />

      {/* Plan */}
      <div className="space-y-2">
        <Label>Subscription Plan</Label>
        <Select value={selectedPlanId} onValueChange={setSelectedPlanId}>
          <SelectTrigger><SelectValue placeholder="Select a plan" /></SelectTrigger>
          <SelectContent>
            {plans.map((plan) => (
              <SelectItem key={plan.id} value={plan.id}>
                <div className="flex items-center justify-between gap-4">
                  <span>{plan.name}</span>
                  <span className="text-muted-foreground text-xs">
                    {formatCurrency(plan.price_monthly)}/mo
                  </span>
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        {selectedPlan && (
          <p className="text-xs text-muted-foreground">
            Yearly: {formatCurrency(selectedPlan.price_yearly)}/year (save {formatCurrency(selectedPlan.price_monthly * 12 - selectedPlan.price_yearly)})
          </p>
        )}
      </div>

      {downgradeWarning && (
        <div className="flex items-start gap-2 p-3 rounded-md bg-destructive/10 border border-destructive/20">
          <AlertCircle className="h-4 w-4 text-destructive mt-0.5 shrink-0" />
          <p className="text-xs text-destructive">{downgradeWarning}</p>
        </div>
      )}

      {/* Status */}
      <div className="space-y-2">
        <Label>Subscription Status</Label>
        <Select value={status} onValueChange={setStatus}>
          <SelectTrigger><SelectValue /></SelectTrigger>
          <SelectContent>
            {SUBSCRIPTION_STATUSES.map((s) => (
              <SelectItem key={s.value} value={s.value}>
                <div className="flex items-center gap-2">
                  <span className={`w-2 h-2 rounded-full ${s.color.replace("/10", "")}`} />
                  {s.label}
                </div>
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
      </div>

      {status === "active" && (
        <div className="space-y-2">
          <Label>Subscription Duration</Label>
          <Select value={selectedDuration} onValueChange={setSelectedDuration}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              {DURATION_OPTIONS.map((d) => (
                <SelectItem key={d.value} value={d.value}>{d.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      )}

      {/* Dates */}
      <div className="grid grid-cols-2 gap-4">
        {status === "trial" && (
          <div className="space-y-2">
            <Label htmlFor="trialEnds" className="flex items-center gap-1">
              <Calendar className="h-3 w-3" /> Trial Ends
            </Label>
            <Input id="trialEnds" type="date" value={trialEndsAt} onChange={(e) => setTrialEndsAt(e.target.value)} />
          </div>
        )}
        <div className={`space-y-2 ${status !== "trial" ? "col-span-2" : ""}`}>
          <Label htmlFor="subscriptionEnds" className="flex items-center gap-1">
            <Calendar className="h-3 w-3" /> Subscription Ends
          </Label>
          <Input
            id="subscriptionEnds"
            type="date"
            value={subscriptionEndsAt}
            onChange={(e) => { setSubscriptionEndsAt(e.target.value); setSelectedDuration("custom"); }}
          />
        </div>
      </div>

      <Separator />

      {/* Record payment */}
      <div className="space-y-4">
        <div className="flex items-center justify-between">
          <Label className="flex items-center gap-2">
            <DollarSign className="h-4 w-4" /> Record Payment
          </Label>
          <Button
            type="button"
            variant={recordPayment ? "default" : "outline"}
            size="sm"
            onClick={() => setRecordPayment(!recordPayment)}
          >
            {recordPayment ? "Recording Payment" : "Add Payment"}
          </Button>
        </div>

        {recordPayment && (
          <div className="space-y-4 p-4 rounded-lg border bg-muted/30">
            <div className="grid grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Payment Method</Label>
                <Select value={paymentMethod} onValueChange={setPaymentMethod}>
                  <SelectTrigger><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="cash">Cash</SelectItem>
                    <SelectItem value="bank_transfer">Bank Transfer</SelectItem>
                    <SelectItem value="stripe">Stripe</SelectItem>
                    <SelectItem value="other">Other</SelectItem>
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>Amount</Label>
                <Input
                  type="number"
                  placeholder="0.00"
                  value={paymentAmount}
                  onChange={(e) => setPaymentAmount(e.target.value)}
                />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Notes (optional)</Label>
              <Textarea
                placeholder="Payment reference, receipt number, etc."
                value={paymentNotes}
                onChange={(e) => setPaymentNotes(e.target.value)}
                rows={2}
              />
            </div>
          </div>
        )}
      </div>

      {footer === "attached" && (
        <div className="flex justify-end gap-2 pt-2">
          {onCancel && (
            <Button type="button" variant="outline" onClick={onCancel}>
              Cancel
            </Button>
          )}
          <Button type="submit" disabled={isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save Changes
          </Button>
        </div>
      )}
    </form>
  );
}

export function useManageSubscriptionSubmitting() {
  // Sentinel — future refactor point if we lift the isSaving state.
  return false;
}
