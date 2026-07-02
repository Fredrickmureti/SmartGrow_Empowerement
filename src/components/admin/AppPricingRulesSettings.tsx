import { normalizeError } from "@/services/resilience";
// @ts-nocheck - Admin tables not in auto-generated types
/**
 * App Pricing Rules Settings
 *
 * Platform-admin UI for managing per-app pricing in the Odoo-style add-on model.
 * Each row in `app_pricing_rules` defines what a tenant pays for an app when it
 * is NOT in their plan (i.e. installed as an add-on) or when their plan is
 * per-user. Rules with `is_addon_only=true` are NEVER auto-included in any
 * plan, even if the platform admin enables them in the plan-app matrix.
 *
 * UI matches the column model:
 *   - app_id (registry-driven select)
 *   - monthly_price, yearly_price, currency
 *   - is_per_user (bill per workspace seat vs flat)
 *   - is_addon_only (block from plan inclusion)
 *   - is_active (soft-disable without losing the row)
 */
import { useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { APP_REGISTRY } from "@/lib/apps/registry";
import { Loader2, Plus, Save, Trash2, Tag } from "lucide-react";

interface PricingRule {
  id: string;
  app_id: string;
  monthly_price: number;
  yearly_price: number;
  currency: string;
  is_per_user: boolean;
  is_addon_only: boolean;
  is_active: boolean;
}

const CURRENCIES = ["USD", "EUR", "GBP", "AED", "SAR", "PKR", "INR"];

const MANAGEABLE_APPS = APP_REGISTRY.filter((a) => !a.isPlatform);

function emptyRule(appId: string): Omit<PricingRule, "id"> {
  return {
    app_id: appId,
    monthly_price: 0,
    yearly_price: 0,
    currency: "USD",
    is_per_user: true,
    is_addon_only: false,
    is_active: true,
  };
}

export function AppPricingRulesSettings() {
  const { toast } = useToast();
  const [rules, setRules] = useState<PricingRule[]>([]);
  const [drafts, setDrafts] = useState<Record<string, Partial<PricingRule>>>({});
  const [isLoading, setIsLoading] = useState(true);
  const [savingId, setSavingId] = useState<string | null>(null);

  useEffect(() => {
    void load();
  }, []);

  async function load() {
    setIsLoading(true);
    try {
      const { data, error } = await (supabase as any)
        .from("app_pricing_rules")
        .select("*")
        .order("app_id");
      if (error) throw error;
      setRules((data ?? []) as PricingRule[]);
    } catch (err: any) {
      toast({ title: "Failed to load pricing rules", description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setIsLoading(false);
    }
  }

  const ruleByApp = useMemo(() => {
    const m = new Map<string, PricingRule>();
    for (const r of rules) m.set(r.app_id, r);
    return m;
  }, [rules]);

  const unconfiguredApps = useMemo(
    () => MANAGEABLE_APPS.filter((a) => !ruleByApp.has(a.id)),
    [ruleByApp],
  );

  function patch(ruleId: string, changes: Partial<PricingRule>) {
    setDrafts((d) => ({ ...d, [ruleId]: { ...d[ruleId], ...changes } }));
  }

  function effective(rule: PricingRule): PricingRule {
    return { ...rule, ...(drafts[rule.id] ?? {}) } as PricingRule;
  }

  async function saveRule(rule: PricingRule) {
    const next = effective(rule);
    if (next.monthly_price < 0 || next.yearly_price < 0) {
      toast({ title: "Invalid price", description: "Prices cannot be negative", variant: "destructive" });
      return;
    }
    setSavingId(rule.id);
    try {
      const { error } = await (supabase as any)
        .from("app_pricing_rules")
        .update({
          monthly_price: next.monthly_price,
          yearly_price: next.yearly_price,
          currency: next.currency,
          is_per_user: next.is_per_user,
          is_addon_only: next.is_addon_only,
          is_active: next.is_active,
        })
        .eq("id", rule.id);
      if (error) throw error;
      setRules((rs) => rs.map((r) => (r.id === rule.id ? next : r)));
      setDrafts((d) => {
        const { [rule.id]: _omit, ...rest } = d;
        return rest;
      });
      toast({ title: "Pricing updated" });
    } catch (err: any) {
      toast({ title: "Save failed", description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setSavingId(null);
    }
  }

  async function createRule(appId: string) {
    setSavingId(appId);
    try {
      const payload = emptyRule(appId);
      const { data, error } = await (supabase as any)
        .from("app_pricing_rules")
        .insert(payload)
        .select()
        .single();
      if (error) throw error;
      setRules((rs) => [...rs, data as PricingRule]);
      toast({ title: "Pricing rule created" });
    } catch (err: any) {
      toast({ title: "Create failed", description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setSavingId(null);
    }
  }

  async function deleteRule(rule: PricingRule) {
    if (!confirm(`Delete pricing rule for ${rule.app_id}? Tenants on this add-on will keep historical billing rows but lose future charges.`)) return;
    setSavingId(rule.id);
    try {
      const { error } = await (supabase as any)
        .from("app_pricing_rules")
        .delete()
        .eq("id", rule.id);
      if (error) throw error;
      setRules((rs) => rs.filter((r) => r.id !== rule.id));
      toast({ title: "Pricing rule deleted" });
    } catch (err: any) {
      toast({ title: "Delete failed", description: normalizeError(err).message, variant: "destructive" });
    } finally {
      setSavingId(null);
    }
  }

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Tag className="h-5 w-5" />
            App Pricing Rules
          </CardTitle>
          <CardDescription>
            Configure per-app monthly/yearly pricing. Apps with{" "}
            <Badge variant="outline" className="mx-1 text-[10px]">Add-on only</Badge>
            cannot be auto-included in any plan; tenants must purchase them separately.
          </CardDescription>
        </CardHeader>
        <CardContent>
          {rules.length === 0 ? (
            <p className="text-sm text-muted-foreground py-6 text-center">
              No pricing rules configured yet. Add one below to enable add-on / per-user billing for an app.
            </p>
          ) : (
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>App</TableHead>
                    <TableHead className="w-32">Monthly</TableHead>
                    <TableHead className="w-32">Yearly</TableHead>
                    <TableHead className="w-28">Currency</TableHead>
                    <TableHead className="w-28">Per-user</TableHead>
                    <TableHead className="w-32">Add-on only</TableHead>
                    <TableHead className="w-24">Active</TableHead>
                    <TableHead className="w-40 text-right">Actions</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {rules.map((rule) => {
                    const def = APP_REGISTRY.find((a) => a.id === rule.app_id);
                    const e = effective(rule);
                    const dirty = !!drafts[rule.id];
                    return (
                      <TableRow key={rule.id}>
                        <TableCell>
                          <div className="font-medium">{def?.name ?? rule.app_id}</div>
                          <div className="text-xs text-muted-foreground">{rule.app_id}</div>
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={e.monthly_price}
                            onChange={(ev) => patch(rule.id, { monthly_price: Number(ev.target.value) })}
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Input
                            type="number"
                            min={0}
                            step="0.01"
                            value={e.yearly_price}
                            onChange={(ev) => patch(rule.id, { yearly_price: Number(ev.target.value) })}
                            className="h-8"
                          />
                        </TableCell>
                        <TableCell>
                          <Select
                            value={e.currency}
                            onValueChange={(v) => patch(rule.id, { currency: v })}
                          >
                            <SelectTrigger className="h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              {CURRENCIES.map((c) => (
                                <SelectItem key={c} value={c}>{c}</SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={e.is_per_user}
                            onCheckedChange={(v) => patch(rule.id, { is_per_user: v })}
                          />
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={e.is_addon_only}
                            onCheckedChange={(v) => patch(rule.id, { is_addon_only: v })}
                          />
                        </TableCell>
                        <TableCell>
                          <Switch
                            checked={e.is_active}
                            onCheckedChange={(v) => patch(rule.id, { is_active: v })}
                          />
                        </TableCell>
                        <TableCell className="text-right">
                          <div className="flex items-center justify-end gap-1">
                            <Button
                              size="sm"
                              variant={dirty ? "default" : "ghost"}
                              disabled={!dirty || savingId === rule.id}
                              onClick={() => saveRule(rule)}
                            >
                              {savingId === rule.id ? (
                                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                              ) : (
                                <Save className="h-3.5 w-3.5" />
                              )}
                            </Button>
                            <Button
                              size="sm"
                              variant="ghost"
                              className="text-destructive hover:text-destructive"
                              disabled={savingId === rule.id}
                              onClick={() => deleteRule(rule)}
                            >
                              <Trash2 className="h-3.5 w-3.5" />
                            </Button>
                          </div>
                        </TableCell>
                      </TableRow>
                    );
                  })}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      {unconfiguredApps.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Add pricing rule</CardTitle>
            <CardDescription>
              Apps without a pricing rule are treated as free add-ons (in_plan or $0 add-on).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-2">
              {unconfiguredApps.map((app) => (
                <Button
                  key={app.id}
                  variant="outline"
                  size="sm"
                  className="justify-start"
                  disabled={savingId === app.id}
                  onClick={() => createRule(app.id)}
                >
                  {savingId === app.id ? (
                    <Loader2 className="h-3.5 w-3.5 animate-spin mr-2" />
                  ) : (
                    <Plus className="h-3.5 w-3.5 mr-2" />
                  )}
                  {app.name}
                </Button>
              ))}
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
