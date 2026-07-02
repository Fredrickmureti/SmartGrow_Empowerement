// @ts-nocheck - Admin tables not in auto-generated types
import { useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Separator } from "@/components/ui/separator";
import { useSubscriptionPlans, SubscriptionPlan } from "@/hooks/useSubscriptionPlans";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { 
  Plus, 
  Pencil, 
  Trash2, 
  Loader2, 
  CreditCard,
  Star,
  Check,
  AlertTriangle,
  Users,
} from "lucide-react";

interface PlanFormData {
  name: string;
  description: string;
  price_monthly: string;
  price_yearly: string;
  price_per_user_monthly: string;
  price_per_user_yearly: string;
  price_monthly_kes: string;
  price_yearly_kes: string;
  features: string;
  max_users: string;
  max_organizations: string;
  max_storage_mb: string;
  grace_period_days: string;
  trial_period_days: string;
  is_popular: boolean;
  is_default: boolean;
  sort_order: string;
}

const DEFAULT_FORM: PlanFormData = {
  name: "",
  description: "",
  price_monthly: "",
  price_yearly: "",
  price_per_user_monthly: "",
  price_per_user_yearly: "",
  price_monthly_kes: "",
  price_yearly_kes: "",
  features: "",
  max_users: "",
  max_organizations: "1",
  max_storage_mb: "",
  grace_period_days: "7",
  trial_period_days: "14",
  is_popular: false,
  is_default: false,
  sort_order: "0",
};

function getPricingWarnings(form: PlanFormData): string[] {
  const warnings: string[] = [];
  const monthly = parseFloat(form.price_monthly) || 0;
  const yearly = parseFloat(form.price_yearly) || 0;
  
  if (yearly > 0 && yearly > monthly * 12) {
    warnings.push("Yearly price is higher than 12× monthly — customers won't choose yearly.");
  }
  if (monthly > 0 && yearly === 0) {
    warnings.push("No yearly price set. Consider offering a discount (e.g., 2 months free).");
  }
  if (monthly === 0 && yearly > 0) {
    warnings.push("Monthly is free but yearly is paid — this may confuse customers.");
  }
  return warnings;
}

export function SubscriptionPlansSettings() {
  const { plans, isLoading, isSaving, createPlan, updatePlan, deletePlan, togglePlanActive } = useSubscriptionPlans();
  const { formatCurrency } = useAdminCurrency();
  const [isDialogOpen, setIsDialogOpen] = useState(false);
  const [editingPlan, setEditingPlan] = useState<SubscriptionPlan | null>(null);
  const [formData, setFormData] = useState<PlanFormData>({ ...DEFAULT_FORM });

  const resetForm = () => {
    setFormData({ ...DEFAULT_FORM });
    setEditingPlan(null);
  };

  const openEditDialog = (plan: SubscriptionPlan) => {
    setEditingPlan(plan);
    setFormData({
      name: plan.name,
      description: plan.description || "",
      price_monthly: plan.price_monthly.toString(),
      price_yearly: plan.price_yearly?.toString() || "",
      price_per_user_monthly: (plan as any).price_per_user_monthly?.toString() || "",
      price_per_user_yearly: (plan as any).price_per_user_yearly?.toString() || "",
      price_monthly_kes: plan.price_monthly_kes?.toString() || "",
      price_yearly_kes: plan.price_yearly_kes?.toString() || "",
      features: plan.features.join("\n"),
      max_users: plan.max_users?.toString() || "",
      max_organizations: (plan.max_organizations ?? 1).toString(),
      max_storage_mb: plan.max_storage_mb?.toString() || "",
      grace_period_days: plan.grace_period_days?.toString() || "7",
      trial_period_days: plan.trial_period_days?.toString() || "14",
      is_popular: plan.is_popular,
      is_default: plan.is_default,
      sort_order: plan.sort_order?.toString() || "0",
    });
    setIsDialogOpen(true);
  };

  const handleSubmit = async () => {
    const planData: Partial<SubscriptionPlan> = {
      name: formData.name,
      description: formData.description || null,
      price_monthly: parseFloat(formData.price_monthly) || 0,
      price_yearly: formData.price_yearly ? parseFloat(formData.price_yearly) : null,
      price_monthly_kes: formData.price_monthly_kes ? parseFloat(formData.price_monthly_kes) : null,
      price_yearly_kes: formData.price_yearly_kes ? parseFloat(formData.price_yearly_kes) : null,
      features: formData.features.split("\n").filter(f => f.trim()),
      max_users: formData.max_users ? parseInt(formData.max_users) : null,
      max_organizations: parseInt(formData.max_organizations) || 1,
      max_storage_mb: formData.max_storage_mb ? parseInt(formData.max_storage_mb) : null,
      grace_period_days: formData.grace_period_days ? parseInt(formData.grace_period_days) : null,
      is_popular: formData.is_popular,
      is_default: formData.is_default,
      trial_period_days: formData.trial_period_days ? parseInt(formData.trial_period_days) : 14,
      sort_order: parseInt(formData.sort_order) || 0,
    };

    // Add per-user pricing
    (planData as any).price_per_user_monthly = formData.price_per_user_monthly ? parseFloat(formData.price_per_user_monthly) : 0;
    (planData as any).price_per_user_yearly = formData.price_per_user_yearly ? parseFloat(formData.price_per_user_yearly) : 0;

    // Remove max_invoices_per_month — paid plans get unlimited
    (planData as any).max_invoices_per_month = (parseFloat(formData.price_monthly) || 0) === 0 ? 50 : null;

    if (editingPlan) {
      await updatePlan(editingPlan.id, planData);
    } else {
      await createPlan(planData);
    }

    setIsDialogOpen(false);
    resetForm();
  };

  const suggestYearly = () => {
    const monthly = parseFloat(formData.price_monthly) || 0;
    if (monthly > 0) {
      setFormData(prev => ({ ...prev, price_yearly: (monthly * 10).toFixed(0) }));
    }
  };

  const suggestPerUserYearly = () => {
    const monthly = parseFloat(formData.price_per_user_monthly) || 0;
    if (monthly > 0) {
      setFormData(prev => ({ ...prev, price_per_user_yearly: (monthly * 10).toFixed(0) }));
    }
  };

  const suggestYearlyKes = () => {
    const monthly = parseFloat(formData.price_monthly_kes) || 0;
    if (monthly > 0) {
      setFormData(prev => ({ ...prev, price_yearly_kes: (monthly * 10).toFixed(0) }));
    }
  };

  const warnings = getPricingWarnings(formData);

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="p-4 sm:p-6">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <CardTitle className="text-base flex items-center gap-2">
              <CreditCard className="h-5 w-5" />
              Subscription Plans
            </CardTitle>
            <CardDescription>
              Configure pricing plans with base price + per-user pricing. Payment is handled automatically by your active payment providers.
            </CardDescription>
          </div>
          <Dialog open={isDialogOpen} onOpenChange={(open) => {
            setIsDialogOpen(open);
            if (!open) resetForm();
          }}>
            <DialogTrigger asChild>
              <Button size="sm" className="w-full sm:w-auto">
                <Plus className="h-4 w-4 mr-2" />
                Add Plan
              </Button>
            </DialogTrigger>
            <DialogContent className="w-[95vw] max-w-2xl max-h-[90vh] overflow-y-auto">
              <DialogHeader>
                <DialogTitle>{editingPlan ? "Edit Plan" : "Create New Plan"}</DialogTitle>
                <DialogDescription>
                  Set the plan details, pricing (base + per-user), and limits.
                </DialogDescription>
              </DialogHeader>

              <div className="grid gap-5 py-4">
                {/* ── Basic Info ── */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3">Basic Info</h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="name">Plan Name *</Label>
                      <Input id="name" value={formData.name} onChange={(e) => setFormData({ ...formData, name: e.target.value })} placeholder="Professional" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="sort_order">Sort Order</Label>
                      <Input id="sort_order" type="number" value={formData.sort_order} onChange={(e) => setFormData({ ...formData, sort_order: e.target.value })} placeholder="0" />
                    </div>
                  </div>
                  <div className="space-y-1.5 mt-3">
                    <Label htmlFor="description">Description</Label>
                    <Input id="description" value={formData.description} onChange={(e) => setFormData({ ...formData, description: e.target.value })} placeholder="Great for growing businesses" />
                  </div>
                </div>

                <Separator />

                {/* ── Base Pricing (USD) ── */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3">Base Pricing — USD</h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="price_monthly">Monthly Base Price *</Label>
                      <Input id="price_monthly" type="number" min="0" step="0.01" value={formData.price_monthly} onChange={(e) => setFormData({ ...formData, price_monthly: e.target.value })} placeholder="24" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="price_yearly">Yearly Base Price</Label>
                      <div className="flex gap-2">
                        <Input id="price_yearly" type="number" min="0" step="0.01" value={formData.price_yearly} onChange={(e) => setFormData({ ...formData, price_yearly: e.target.value })} placeholder="240" className="flex-1" />
                        <Button type="button" variant="outline" size="sm" className="text-xs whitespace-nowrap" onClick={suggestYearly}>2mo free</Button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Per-User Pricing ── */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3 flex items-center gap-2">
                    <Users className="h-4 w-4" />
                    Per-User Pricing — USD
                    <span className="font-normal text-xs">(charged per active user beyond included)</span>
                  </h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="price_per_user_monthly">Monthly Per User</Label>
                      <Input id="price_per_user_monthly" type="number" min="0" step="0.01" value={formData.price_per_user_monthly} onChange={(e) => setFormData({ ...formData, price_per_user_monthly: e.target.value })} placeholder="7" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="price_per_user_yearly">Yearly Per User</Label>
                      <div className="flex gap-2">
                        <Input id="price_per_user_yearly" type="number" min="0" step="0.01" value={formData.price_per_user_yearly} onChange={(e) => setFormData({ ...formData, price_per_user_yearly: e.target.value })} placeholder="70" className="flex-1" />
                        <Button type="button" variant="outline" size="sm" className="text-xs whitespace-nowrap" onClick={suggestPerUserYearly}>2mo free</Button>
                      </div>
                    </div>
                  </div>
                </div>

                {/* ── Pricing (KES) ── */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3">Pricing — KES <span className="font-normal">(optional)</span></h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="price_monthly_kes">Monthly (KES)</Label>
                      <Input id="price_monthly_kes" type="number" min="0" value={formData.price_monthly_kes} onChange={(e) => setFormData({ ...formData, price_monthly_kes: e.target.value })} placeholder="4,500" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="price_yearly_kes">Yearly (KES)</Label>
                      <div className="flex gap-2">
                        <Input id="price_yearly_kes" type="number" min="0" value={formData.price_yearly_kes} onChange={(e) => setFormData({ ...formData, price_yearly_kes: e.target.value })} placeholder="43,000" className="flex-1" />
                        <Button type="button" variant="outline" size="sm" className="text-xs whitespace-nowrap" onClick={suggestYearlyKes}>2mo free</Button>
                      </div>
                    </div>
                  </div>
                </div>

                {warnings.length > 0 && (
                  <div className="rounded-lg border border-amber-200 bg-amber-50 dark:bg-amber-950/20 dark:border-amber-800 p-3 space-y-1">
                    {warnings.map((w, i) => (
                      <div key={i} className="flex items-start gap-2 text-xs text-amber-700 dark:text-amber-400">
                        <AlertTriangle className="h-3.5 w-3.5 mt-0.5 shrink-0" />
                        <span>{w}</span>
                      </div>
                    ))}
                  </div>
                )}

                <Separator />

                {/* ── Limits ── */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3">Plan Limits <span className="font-normal">(empty = unlimited)</span></h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="max_users">Max Users</Label>
                      <Input id="max_users" type="number" min="1" value={formData.max_users} onChange={(e) => setFormData({ ...formData, max_users: e.target.value })} placeholder="∞" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="max_organizations">Max Organizations</Label>
                      <Input id="max_organizations" type="number" min="1" value={formData.max_organizations} onChange={(e) => setFormData({ ...formData, max_organizations: e.target.value })} placeholder="1" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="max_storage_mb">Max Storage (MB)</Label>
                      <Input id="max_storage_mb" type="number" min="0" value={formData.max_storage_mb} onChange={(e) => setFormData({ ...formData, max_storage_mb: e.target.value })} placeholder="∞" />
                    </div>
                  </div>
                  <p className="text-xs text-muted-foreground mt-2">
                    Invoices are unlimited for all paid plans. Free plan is limited to 50/month.
                  </p>
                </div>

                <Separator />

                {/* ── Trial & Grace ── */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-3">Trial & Grace Period</h4>
                  <div className="grid gap-3 sm:grid-cols-2">
                    <div className="space-y-1.5">
                      <Label htmlFor="trial_period_days">Trial Period (days)</Label>
                      <Input id="trial_period_days" type="number" min="0" value={formData.trial_period_days} onChange={(e) => setFormData({ ...formData, trial_period_days: e.target.value })} placeholder="14" />
                    </div>
                    <div className="space-y-1.5">
                      <Label htmlFor="grace_period_days">Grace Period (days)</Label>
                      <Input id="grace_period_days" type="number" min="0" value={formData.grace_period_days} onChange={(e) => setFormData({ ...formData, grace_period_days: e.target.value })} placeholder="7" />
                    </div>
                  </div>
                </div>

                <Separator />

                {/* ── Marketing (Display Only) ── */}
                <div>
                  <h4 className="text-sm font-semibold text-muted-foreground mb-1">Marketing Bullets</h4>
                  <p className="text-xs text-muted-foreground mb-3">These are shown on the pricing page. They do not enforce access — use Plan Limits and App Packaging for that.</p>
                  <div className="space-y-1.5">
                    <Label htmlFor="features">Feature Bullets (one per line)</Label>
                    <Textarea id="features" value={formData.features} onChange={(e) => setFormData({ ...formData, features: e.target.value })} placeholder={"Unlimited invoices\n10 team members\nPriority support"} rows={4} />
                  </div>
                  <div className="flex flex-col sm:flex-row gap-4 mt-3">
                    <div className="flex items-center gap-2">
                      <Switch id="is_popular" checked={formData.is_popular} onCheckedChange={(checked) => setFormData({ ...formData, is_popular: checked })} />
                      <Label htmlFor="is_popular" className="text-sm">Popular Badge</Label>
                    </div>
                    <div className="flex items-center gap-2">
                      <Switch id="is_default" checked={formData.is_default} onCheckedChange={(checked) => setFormData({ ...formData, is_default: checked })} />
                      <Label htmlFor="is_default" className="text-sm">Default Plan</Label>
                    </div>
                  </div>
                </div>
              </div>

              <DialogFooter className="flex-col sm:flex-row gap-2">
                <Button variant="outline" onClick={() => setIsDialogOpen(false)} className="w-full sm:w-auto">Cancel</Button>
                <Button onClick={handleSubmit} disabled={isSaving || !formData.name} className="w-full sm:w-auto">
                  {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                  {editingPlan ? "Update Plan" : "Create Plan"}
                </Button>
              </DialogFooter>
            </DialogContent>
          </Dialog>
        </div>
      </CardHeader>
      <CardContent className="p-4 sm:p-6 pt-0 sm:pt-0">
        {/* Desktop: Table layout */}
        <div className="hidden md:block rounded-md border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Plan</TableHead>
                <TableHead>Base Pricing</TableHead>
                <TableHead>Per User</TableHead>
                <TableHead>Limits</TableHead>
                <TableHead>Status</TableHead>
                <TableHead className="w-[100px]">Actions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {plans.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={6} className="text-center py-8 text-muted-foreground">
                    No subscription plans configured
                  </TableCell>
                </TableRow>
              ) : (
                plans.map((plan) => (
                  <TableRow key={plan.id}>
                    <TableCell>
                      <div className="flex items-center gap-2">
                        <span className="font-medium">{plan.name}</span>
                        {plan.is_default && (
                          <Badge variant="outline" className="border-primary text-primary">
                            <Check className="h-3 w-3 mr-1" />
                            Default
                          </Badge>
                        )}
                        {plan.is_popular && (
                          <Badge variant="default" className="bg-amber-500">
                            <Star className="h-3 w-3 mr-1" />
                            Popular
                          </Badge>
                        )}
                      </div>
                      {plan.description && (
                        <p className="text-sm text-muted-foreground">{plan.description}</p>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="font-medium">
                        {formatCurrency(plan.price_monthly)}/mo
                      </div>
                      {plan.price_yearly && (
                        <div className="text-sm text-muted-foreground">
                          {formatCurrency(plan.price_yearly)}/yr
                        </div>
                      )}
                    </TableCell>
                    <TableCell>
                      <div className="text-sm">
                        {((plan as any).price_per_user_monthly ?? 0) > 0 ? (
                          <>
                            <div className="font-medium">{formatCurrency((plan as any).price_per_user_monthly)}/user/mo</div>
                            {((plan as any).price_per_user_yearly ?? 0) > 0 && (
                              <div className="text-muted-foreground">{formatCurrency((plan as any).price_per_user_yearly)}/user/yr</div>
                            )}
                          </>
                        ) : (
                          <span className="text-muted-foreground">—</span>
                        )}
                      </div>
                    </TableCell>
                    <TableCell>
                      <div className="text-sm space-y-0.5">
                        <div>{plan.max_users ?? "∞"} users</div>
                        <div className="text-muted-foreground">{plan.max_organizations ?? 1} org{(plan.max_organizations ?? 1) !== 1 ? "s" : ""}</div>
                      </div>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={plan.is_active}
                        onCheckedChange={(checked) => togglePlanActive(plan.id, checked)}
                      />
                    </TableCell>
                    <TableCell>
                      <div className="flex items-center gap-1">
                        <Button variant="ghost" size="icon" onClick={() => openEditDialog(plan)}>
                          <Pencil className="h-4 w-4" />
                        </Button>
                        <Button variant="ghost" size="icon" onClick={() => deletePlan(plan.id)}>
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      </div>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </div>

        {/* Mobile: Card layout */}
        <div className="md:hidden space-y-3">
          {plans.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              No subscription plans configured
            </div>
          ) : (
            plans.map((plan) => (
              <div key={plan.id} className="rounded-lg border bg-card p-4 space-y-3">
                <div className="flex items-start justify-between">
                  <div className="space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-medium">{plan.name}</span>
                      {plan.is_default && (
                        <Badge variant="outline" className="border-primary text-primary text-xs">Default</Badge>
                      )}
                      {plan.is_popular && (
                        <Badge variant="default" className="bg-amber-500 text-xs">Popular</Badge>
                      )}
                    </div>
                    {plan.description && (
                      <p className="text-sm text-muted-foreground">{plan.description}</p>
                    )}
                  </div>
                  <Switch checked={plan.is_active} onCheckedChange={(checked) => togglePlanActive(plan.id, checked)} />
                </div>

                <div className="grid grid-cols-2 gap-3 text-sm">
                  <div className="p-2.5 rounded-md bg-muted/50">
                    <span className="text-muted-foreground text-xs">Monthly</span>
                    <div className="font-medium">{formatCurrency(plan.price_monthly)}</div>
                  </div>
                  <div className="p-2.5 rounded-md bg-muted/50">
                    <span className="text-muted-foreground text-xs">Per User/mo</span>
                    <div className="font-medium">
                      {((plan as any).price_per_user_monthly ?? 0) > 0 ? formatCurrency((plan as any).price_per_user_monthly) : "—"}
                    </div>
                  </div>
                  <div className="p-2.5 rounded-md bg-muted/50">
                    <span className="text-muted-foreground text-xs">Users</span>
                    <div className="font-medium">{plan.max_users ?? "Unlimited"}</div>
                  </div>
                  <div className="p-2.5 rounded-md bg-muted/50">
                    <span className="text-muted-foreground text-xs">Organizations</span>
                    <div className="font-medium">{plan.max_organizations ?? 1}</div>
                  </div>
                </div>

                <div className="flex items-center gap-2 pt-1 border-t">
                  <Button variant="outline" size="sm" className="flex-1" onClick={() => openEditDialog(plan)}>
                    <Pencil className="h-3.5 w-3.5 mr-1.5" />
                    Edit
                  </Button>
                  <Button variant="outline" size="sm" className="text-destructive hover:text-destructive" onClick={() => deletePlan(plan.id)}>
                    <Trash2 className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))
          )}
        </div>
      </CardContent>
    </Card>
  );
}
