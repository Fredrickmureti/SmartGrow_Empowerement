import { normalizeError } from "@/services/resilience";
// @ts-nocheck - app_dependencies not in auto-generated types
/**
 * AppDependenciesMatrix — platform-admin editor for the `app_dependencies`
 * graph that drives install/uninstall preflights and billing cascades.
 *
 * Each row is a directed edge: `app_id` requires `depends_on_app_id`.
 *
 * Editable per row:
 *   - dependency_type: required | optional | setup_only
 *   - auto_install:    boolean (only meaningful for required + setup_only)
 *   - billing_behavior: separate (billed on its own) | free_foundation
 *                      (included free when installed as a dep) |
 *                      bundled (counted as part of parent's price)
 *
 * Validation:
 *   - no self-edges (app_id !== depends_on_app_id)
 *   - no duplicate edges
 *   - no cycles (DFS check on the proposed graph before save)
 *
 * Direct table writes — no new edge function required.
 */
import { useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Save, Loader2, GitMerge, AlertTriangle } from "lucide-react";

import { supabase } from "@/integrations/supabase/client";
import { useToast } from "@/hooks/use-toast";
import { APP_REGISTRY } from "@/lib/apps/registry";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

type DependencyType = "required" | "optional" | "setup_only";
type BillingBehavior = "separate" | "free_foundation" | "bundled";

interface DepRow {
  id?: string;
  app_id: string;
  depends_on_app_id: string;
  dependency_type: DependencyType;
  auto_install: boolean;
  billing_behavior: BillingBehavior;
  _isNew?: boolean;
  _dirty?: boolean;
  _toDelete?: boolean;
}

const MANAGEABLE_APPS = APP_REGISTRY.filter((a) => !a.isPlatform);

function detectCycle(edges: DepRow[]): string[] | null {
  // Returns the cycle as a list of app ids, or null if acyclic.
  // Only considers required + setup_only deps (optional doesn't force install).
  const adj = new Map<string, string[]>();
  for (const e of edges) {
    if (e._toDelete) continue;
    if (e.dependency_type === "optional") continue;
    if (!adj.has(e.app_id)) adj.set(e.app_id, []);
    adj.get(e.app_id)!.push(e.depends_on_app_id);
  }

  const WHITE = 0,
    GRAY = 1,
    BLACK = 2;
  const color = new Map<string, number>();
  const parent = new Map<string, string | null>();

  const dfs = (u: string): string[] | null => {
    color.set(u, GRAY);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GRAY) {
        // cycle found — reconstruct
        const cycle: string[] = [v, u];
        let p = parent.get(u);
        while (p && p !== v) {
          cycle.push(p);
          p = parent.get(p)!;
        }
        cycle.reverse();
        return cycle;
      }
      if (c === WHITE) {
        parent.set(v, u);
        const found = dfs(v);
        if (found) return found;
      }
    }
    color.set(u, BLACK);
    return null;
  };

  for (const node of adj.keys()) {
    if ((color.get(node) ?? WHITE) === WHITE) {
      parent.set(node, null);
      const found = dfs(node);
      if (found) return found;
    }
  }
  return null;
}

export function AppDependenciesMatrix() {
  const { toast } = useToast();
  const [rows, setRows] = useState<DepRow[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);

  useEffect(() => {
    (async () => {
      const { data, error } = await supabase
        .from("app_dependencies")
        .select("*")
        .order("app_id");
      if (!error) setRows((data ?? []) as DepRow[]);
      setIsLoading(false);
    })();
  }, []);

  const dirty = useMemo(
    () => rows.some((r) => r._isNew || r._dirty || r._toDelete),
    [rows],
  );

  const cycle = useMemo(() => detectCycle(rows), [rows]);

  const dupKeys = useMemo(() => {
    const seen = new Map<string, number>();
    const dups = new Set<string>();
    rows.forEach((r) => {
      if (r._toDelete) return;
      const k = `${r.app_id}→${r.depends_on_app_id}`;
      const n = (seen.get(k) ?? 0) + 1;
      seen.set(k, n);
      if (n > 1) dups.add(k);
    });
    return dups;
  }, [rows]);

  const selfEdges = useMemo(
    () =>
      rows.some(
        (r) =>
          !r._toDelete && r.app_id && r.app_id === r.depends_on_app_id,
      ),
    [rows],
  );

  const update = (idx: number, patch: Partial<DepRow>) => {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, ...patch, _dirty: true } : r)),
    );
  };

  const addRow = () => {
    setRows((prev) => [
      ...prev,
      {
        app_id: "",
        depends_on_app_id: "",
        dependency_type: "required",
        auto_install: true,
        billing_behavior: "separate",
        _isNew: true,
      },
    ]);
  };

  const remove = (idx: number) => {
    setRows((prev) => {
      const r = prev[idx];
      if (r._isNew) return prev.filter((_, i) => i !== idx);
      return prev.map((row, i) =>
        i === idx ? { ...row, _toDelete: true } : row,
      );
    });
  };

  const undoRemove = (idx: number) => {
    setRows((prev) =>
      prev.map((r, i) => (i === idx ? { ...r, _toDelete: false } : r)),
    );
  };

  const canSave = dirty && !cycle && dupKeys.size === 0 && !selfEdges;

  const save = async () => {
    if (!canSave) return;
    setIsSaving(true);
    try {
      const toInsert = rows
        .filter((r) => r._isNew && !r._toDelete && r.app_id && r.depends_on_app_id)
        .map((r) => ({
          app_id: r.app_id,
          depends_on_app_id: r.depends_on_app_id,
          dependency_type: r.dependency_type,
          auto_install: r.auto_install,
          billing_behavior: r.billing_behavior,
        }));

      const toUpdate = rows.filter(
        (r) => !r._isNew && r._dirty && !r._toDelete && r.id,
      );

      const toDelete = rows.filter((r) => !r._isNew && r._toDelete && r.id);

      if (toDelete.length > 0) {
        const { error } = await supabase
          .from("app_dependencies")
          .delete()
          .in("id", toDelete.map((r) => r.id!));
        if (error) throw error;
      }

      for (const r of toUpdate) {
        const { error } = await supabase
          .from("app_dependencies")
          .update({
            dependency_type: r.dependency_type,
            auto_install: r.auto_install,
            billing_behavior: r.billing_behavior,
          })
          .eq("id", r.id!);
        if (error) throw error;
      }

      if (toInsert.length > 0) {
        const { error } = await supabase
          .from("app_dependencies")
          .insert(toInsert);
        if (error) throw error;
      }

      const { data } = await supabase
        .from("app_dependencies")
        .select("*")
        .order("app_id");
      setRows((data ?? []) as DepRow[]);
      toast({
        title: "Dependencies updated",
        description: "Install preflights will use the new graph immediately.",
      });
    } catch (e: any) {
      toast({
        title: "Save failed",
        description: normalizeError(e).message ?? "Could not save dependencies.",
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  if (isLoading) {
    return (
      <div className="flex justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-col sm:flex-row sm:items-start sm:justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2">
            <GitMerge className="h-5 w-5 text-primary" />
            App Dependencies
          </CardTitle>
          <CardDescription>
            Directed edges that drive install preflights ("Installing Payroll
            also installs Employees + Finance") and uninstall blockers ("Can't
            uninstall Inventory while POS is installed").
          </CardDescription>
        </div>
        <div className="flex gap-2 shrink-0">
          <Button variant="outline" size="sm" onClick={addRow}>
            <Plus className="h-4 w-4 mr-1" /> Add edge
          </Button>
          <Button
            size="sm"
            disabled={!canSave || isSaving}
            onClick={save}
          >
            {isSaving ? (
              <Loader2 className="h-4 w-4 animate-spin mr-1" />
            ) : (
              <Save className="h-4 w-4 mr-1" />
            )}
            Save
          </Button>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        {selfEdges && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              An app cannot depend on itself. Fix self-edges before saving.
            </AlertDescription>
          </Alert>
        )}
        {dupKeys.size > 0 && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Duplicate edges:{" "}
              {Array.from(dupKeys).map((k) => (
                <Badge key={k} variant="outline" className="mx-0.5">
                  {k}
                </Badge>
              ))}
            </AlertDescription>
          </Alert>
        )}
        {cycle && (
          <Alert variant="destructive">
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Required-dependency cycle detected: {cycle.join(" → ")}. Cycles
              would cause install loops — break the cycle before saving.
            </AlertDescription>
          </Alert>
        )}

        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-[180px]">App</TableHead>
                <TableHead className="min-w-[180px]">Depends on</TableHead>
                <TableHead className="min-w-[140px]">Type</TableHead>
                <TableHead className="min-w-[110px]">Auto-install</TableHead>
                <TableHead className="min-w-[160px]">Billing</TableHead>
                <TableHead className="w-10" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {rows.length === 0 && (
                <TableRow>
                  <TableCell
                    colSpan={6}
                    className="text-center text-muted-foreground py-8"
                  >
                    No dependencies yet. Add an edge to start.
                  </TableCell>
                </TableRow>
              )}
              {rows.map((row, idx) => {
                const isDel = row._toDelete;
                return (
                  <TableRow
                    key={row.id ?? `new-${idx}`}
                    className={isDel ? "opacity-40 line-through" : ""}
                  >
                    <TableCell>
                      <Select
                        value={row.app_id}
                        onValueChange={(v) => update(idx, { app_id: v })}
                        disabled={isDel}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select app" />
                        </SelectTrigger>
                        <SelectContent>
                          {MANAGEABLE_APPS.map((app) => (
                            <SelectItem key={app.id} value={app.id}>
                              {app.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={row.depends_on_app_id}
                        onValueChange={(v) =>
                          update(idx, { depends_on_app_id: v })
                        }
                        disabled={isDel}
                      >
                        <SelectTrigger>
                          <SelectValue placeholder="Select dep" />
                        </SelectTrigger>
                        <SelectContent>
                          {MANAGEABLE_APPS.map((app) => (
                            <SelectItem key={app.id} value={app.id}>
                              {app.name}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Select
                        value={row.dependency_type}
                        onValueChange={(v) =>
                          update(idx, {
                            dependency_type: v as DependencyType,
                          })
                        }
                        disabled={isDel}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="required">Required</SelectItem>
                          <SelectItem value="optional">Optional</SelectItem>
                          <SelectItem value="setup_only">
                            Setup-only
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      <Switch
                        checked={row.auto_install}
                        onCheckedChange={(v) =>
                          update(idx, { auto_install: v })
                        }
                        disabled={
                          isDel || row.dependency_type === "optional"
                        }
                      />
                    </TableCell>
                    <TableCell>
                      <Select
                        value={row.billing_behavior}
                        onValueChange={(v) =>
                          update(idx, {
                            billing_behavior: v as BillingBehavior,
                          })
                        }
                        disabled={isDel}
                      >
                        <SelectTrigger>
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="separate">
                            Billed separately
                          </SelectItem>
                          <SelectItem value="free_foundation">
                            Free foundation
                          </SelectItem>
                          <SelectItem value="bundled">
                            Bundled with parent
                          </SelectItem>
                        </SelectContent>
                      </Select>
                    </TableCell>
                    <TableCell>
                      {isDel ? (
                        <Button
                          variant="ghost"
                          size="sm"
                          onClick={() => undoRemove(idx)}
                        >
                          Undo
                        </Button>
                      ) : (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-8 w-8 text-destructive"
                          onClick={() => remove(idx)}
                        >
                          <Trash2 className="h-4 w-4" />
                        </Button>
                      )}
                    </TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>

        <p className="text-xs text-muted-foreground">
          <strong>Required</strong> deps install with the parent.{" "}
          <strong>Optional</strong> deps surface as suggestions only.{" "}
          <strong>Setup-only</strong> deps are installed first when present
          but the parent can run before they're configured.
        </p>
      </CardContent>
    </Card>
  );
}
