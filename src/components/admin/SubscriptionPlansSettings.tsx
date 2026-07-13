// @ts-nocheck - Admin tables not in auto-generated types
import { useNavigate } from "react-router-dom";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
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
} from "lucide-react";

export function SubscriptionPlansSettings() {
  const navigate = useNavigate();
  const { plans, isLoading, deletePlan, togglePlanActive } = useSubscriptionPlans();
  const { formatCurrency } = useAdminCurrency();
  const openCreate = () => navigate("/admin-management/plan-builder/plans/new");
  const openEditDialog = (plan: SubscriptionPlan) =>
    navigate(`/admin-management/plan-builder/plans/${plan.id}/edit`);

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
          <Button size="sm" className="w-full sm:w-auto" onClick={openCreate}>
            <Plus className="h-4 w-4 mr-2" />
            Add Plan
          </Button>
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
