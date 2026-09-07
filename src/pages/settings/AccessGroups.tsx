import { useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { usePermissionGroups, PermissionGroupWithRules } from "@/hooks/usePermissionGroups";
import { ACTIVE_PERMISSION_MODULES, MODULE_LABELS, PermissionModule } from "@/lib/permissions";
import { isModuleAppInstalled } from "@/lib/apps/module-app-map";
import { useInstalledApps } from "@/hooks/useInstalledApps";
import { Plus, Pencil, Trash2, Shield, Loader2, Lock, Info, ChevronDown, PackageX } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { AppAccessApprovalsInbox } from "@/components/settings/AppAccessApprovalsInbox";


interface RuleFlags {
  can_read: boolean;
  can_create: boolean;
  can_write: boolean;
  can_delete: boolean;
  can_approve: boolean;
  can_post: boolean;
  can_pay: boolean;
  can_export: boolean;
  can_admin_override: boolean;
}

interface GroupFormData {
  name: string;
  description: string;
  rules: Record<PermissionModule, RuleFlags>;
}

const FLAG_FIELDS = [
  "can_read", "can_create", "can_write", "can_delete",
  "can_approve", "can_post", "can_pay", "can_export", "can_admin_override",
] as const;

const emptyRules = (): GroupFormData["rules"] => {
  const rules = {} as GroupFormData["rules"];
  for (const mod of ACTIVE_PERMISSION_MODULES) {
    rules[mod] = {
      can_read: false, can_create: false, can_write: false, can_delete: false,
      can_approve: false, can_post: false, can_pay: false, can_export: false,
      can_admin_override: false,
    };
  }
  return rules;
};

const groupToFormData = (group: PermissionGroupWithRules): GroupFormData => {
  const rules = emptyRules();
  for (const rule of group.rules) {
    if (rules[rule.module as PermissionModule]) {
      rules[rule.module as PermissionModule] = {
        can_read: rule.can_read,
        can_create: rule.can_create,
        can_write: rule.can_write,
        can_delete: rule.can_delete,
        can_approve: (rule as any).can_approve ?? false,
        can_post: (rule as any).can_post ?? false,
        can_pay: (rule as any).can_pay ?? false,
        can_export: (rule as any).can_export ?? false,
        can_admin_override: (rule as any).can_admin_override ?? false,
      };
    }
  }
  return { name: group.name, description: group.description || "", rules };
};

export default function AccessGroups() {
  const { groups, isLoading, createGroup, updateGroup, deleteGroup } = usePermissionGroups();
  // eslint-disable-next-line local/no-raw-installed-apps-loading-gate -- decoration: page-level spinner, not an install gate
  const { installedAppIds, isLoading: appsLoading } = useInstalledApps();
  const [showForm, setShowForm] = useState(false);
  const [editingGroup, setEditingGroup] = useState<PermissionGroupWithRules | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<PermissionGroupWithRules | null>(null);
  const [formData, setFormData] = useState<GroupFormData>({ name: "", description: "", rules: emptyRules() });
  const [showInactive, setShowInactive] = useState(false);

  // Stage 5 — App-aware visibility.
  // Split the active permission catalogue into modules whose owning app is
  // installed (editable, prominent) vs. modules whose app is uninstalled
  // (rendered in a collapsed, read-only "Inactive apps" section so admins
  // can SEE existing rules without editing them — Odoo behaviour).
  const { activeModules, inactiveModules } = useMemo(() => {
    const active: PermissionModule[] = [];
    const inactive: PermissionModule[] = [];
    for (const mod of ACTIVE_PERMISSION_MODULES) {
      if (isModuleAppInstalled(mod, installedAppIds)) active.push(mod);
      else inactive.push(mod);
    }
    return { activeModules: active, inactiveModules: inactive };
  }, [installedAppIds]);


  const openCreate = () => {
    setEditingGroup(null);
    setFormData({ name: "", description: "", rules: emptyRules() });
    setShowForm(true);
  };

  const openEdit = (group: PermissionGroupWithRules) => {
    setEditingGroup(group);
    setFormData(groupToFormData(group));
    setShowForm(true);
  };

  const handleSave = async () => {
    // Detect modules whose row has at least one previously-saved flag but
    // now has every flag unchecked. The save would silently drop those
    // rules — warn the admin so they can confirm or recheck.
    const previouslyCheckedModules = editingGroup
      ? new Set(editingGroup.rules.map(r => r.module as PermissionModule))
      : new Set<PermissionModule>();
    const aboutToDrop = ACTIVE_PERMISSION_MODULES.filter(mod => {
      const r = formData.rules[mod];
      return previouslyCheckedModules.has(mod) && FLAG_FIELDS.every(f => !r[f]);
    });
    if (aboutToDrop.length > 0) {
      const labels = aboutToDrop.map(m => MODULE_LABELS[m] ?? m).join(", ");
      const ok = window.confirm(
        `These module rules will be REMOVED on save (every permission unchecked):\n\n• ${labels}\n\nUsers in this group will lose all access to those modules. Continue?`,
      );
      if (!ok) return;
    }

    const rules = ACTIVE_PERMISSION_MODULES
      .filter(mod => {
        const r = formData.rules[mod];
        return FLAG_FIELDS.some(f => r[f]);
      })
      .map(mod => ({ module: mod, ...formData.rules[mod] }));

    if (editingGroup) {
      await updateGroup.mutateAsync({ id: editingGroup.id, name: formData.name, description: formData.description, rules });
    } else {
      await createGroup.mutateAsync({ name: formData.name, description: formData.description, rules });
    }
    setShowForm(false);
  };

  const handleDelete = async () => {
    if (deleteTarget) {
      await deleteGroup.mutateAsync(deleteTarget.id);
      setDeleteTarget(null);
    }
  };

  const toggleRule = (mod: PermissionModule, field: typeof FLAG_FIELDS[number]) => {
    setFormData(prev => ({
      ...prev,
      rules: {
        ...prev.rules,
        [mod]: { ...prev.rules[mod], [field]: !prev.rules[mod][field] },
      },
    }));
  };

  if (isLoading || appsLoading) {
    return (
      <Card>
        <CardHeader>
          <Skeleton className="h-6 w-48" />
          <Skeleton className="h-4 w-72" />
        </CardHeader>
        <CardContent className="space-y-3">
          <Skeleton className="h-16 w-full" />
          <Skeleton className="h-16 w-full" />
        </CardContent>
      </Card>
    );
  }

  return (
    <>
      <div className="space-y-6">
        <AppAccessApprovalsInbox />
      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-start gap-3 sm:justify-between">
          <div className="min-w-0">
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5 shrink-0" />
              Access Groups
            </CardTitle>
            <CardDescription className="mt-1">
              Define module-level permission sets for internal users (e.g. "Lending / Loan Officer", "Accounting / Manager"). Portal users have fixed access and are not configurable here.
            </CardDescription>
          </div>
          <Button onClick={openCreate} size="sm" className="shrink-0 w-full sm:w-auto">
            <Plus className="mr-2 h-4 w-4" />
            New Group
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert className="border-border bg-muted/50">
            <Info className="h-4 w-4 text-muted-foreground" />
            <AlertDescription className="text-muted-foreground">
              <strong className="text-foreground">Staff only.</strong> Access Groups grant granular permissions (Read/Create/Write/Delete/Approve/Post/Pay) over lending, accounting and treasury areas. Client portal users have fixed self-service access and cannot be assigned to groups.
            </AlertDescription>
          </Alert>
          {/* System groups are visible (with a System badge) but cannot be edited
              or deleted. They are the standard microfinance job roles
              (Institution Admin, Branch Manager, Loan Officer, Credit Analyst,
              Cashier / Teller, Accountant, Auditor). */}
          {groups.length === 0 ? (
            <div className="text-center py-8 text-muted-foreground">
              <Shield className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p>No access groups yet. Create one to assign granular permissions to staff.</p>
              <p className="text-xs mt-1">
                Examples: "Recovery Officer", "Regional Auditor", "Branch Accountant"
              </p>
            </div>
          ) : (
            <div className="space-y-3">
              {groups.map(group => (
                <div key={group.id} className="border rounded-lg p-3 sm:p-4 space-y-2">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0 space-y-1">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="font-medium truncate">{group.name}</span>
                        {group.is_system && <Badge variant="secondary" className="shrink-0"><Lock className="h-3 w-3 mr-1" />System</Badge>}
                      </div>
                      {group.description && <p className="text-sm text-muted-foreground line-clamp-2">{group.description}</p>}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {!group.is_system && (
                        <>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => openEdit(group)}>
                            <Pencil className="h-4 w-4" />
                          </Button>
                          <Button variant="ghost" size="icon" className="h-8 w-8" onClick={() => setDeleteTarget(group)}>
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
                        </>
                      )}
                    </div>
                  </div>
                  <div className="flex flex-wrap gap-1">
                    {group.rules.map(rule => (
                      <Badge key={rule.id} variant="outline" className="text-xs">
                        {MODULE_LABELS[rule.module as PermissionModule] || rule.module}
                        {": "}
                        {[
                          rule.can_read && "R", rule.can_create && "C", rule.can_write && "W", rule.can_delete && "D",
                          (rule as any).can_approve && "Ap", (rule as any).can_post && "Po", (rule as any).can_pay && "Pa", (rule as any).can_export && "Ex",
                          (rule as any).can_admin_override && "Ov",
                        ].filter(Boolean).join("")}
                      </Badge>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
      </div>

      {/* Create/Edit Dialog */}
      <Dialog open={showForm} onOpenChange={setShowForm}>
        <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto w-[95vw] sm:w-auto">
          <DialogHeader>
            <DialogTitle>{editingGroup ? "Edit Access Group" : "Create Access Group"}</DialogTitle>
          </DialogHeader>

          <div className="space-y-4">
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div className="space-y-2">
                <Label>Group Name</Label>
                <Input
                  value={formData.name}
                  onChange={e => setFormData(p => ({ ...p, name: e.target.value }))}
                  placeholder="e.g. Portfolio View Only"
                />
              </div>
              <div className="space-y-2">
                <Label>Description</Label>
                <Textarea
                  value={formData.description}
                  onChange={e => setFormData(p => ({ ...p, description: e.target.value }))}
                  placeholder="What this group allows..."
                  rows={1}
                />
              </div>
            </div>

            {/* Permission Matrix — installed apps (editable) */}
            <div className="border rounded-lg overflow-x-auto">
              <table className="w-full text-sm min-w-[640px]">
                <thead>
                  <tr className="bg-muted/50">
                    <th className="text-left p-3 font-medium">Module</th>
                    <th className="text-center p-2 font-medium w-16">Read</th>
                    <th className="text-center p-2 font-medium w-16">Create</th>
                    <th className="text-center p-2 font-medium w-16">Write</th>
                    <th className="text-center p-2 font-medium w-16">Delete</th>
                    <th className="text-center p-2 font-medium w-16" title="Approve loan applications and journal entries">Approve</th>
                    <th className="text-center p-2 font-medium w-16" title="Post draft → posted (journal entries)">Post</th>
                    <th className="text-center p-2 font-medium w-16" title="Disburse loans and settle repayments">Pay</th>
                    <th className="text-center p-2 font-medium w-16" title="Export sensitive data (GL and portfolio reports)">Export</th>
                    <th className="text-center p-2 font-medium w-20" title="Bypass maker-checker: allow creator to also approve. Use sparingly.">Override</th>
                  </tr>
                </thead>
                <tbody>
                  {activeModules.map(mod => (
                    <tr key={mod} className="border-t">
                      <td className="p-3 font-medium">{MODULE_LABELS[mod]}</td>
                      {FLAG_FIELDS.map(field => (
                        <td key={field} className="text-center p-2">
                          <Checkbox
                            checked={formData.rules[mod][field]}
                            onCheckedChange={() => toggleRule(mod, field)}
                          />
                        </td>
                      ))}
                    </tr>
                  ))}
                  {activeModules.length === 0 && (
                    <tr>
                      <td colSpan={10} className="p-6 text-center text-sm text-muted-foreground">
                        No installable apps detected. Install apps from Settings → Apps to configure their permissions.
                      </td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>

            {/* Inactive apps — modules whose owning app is not installed.
                Rules existing on these modules are preserved (re-installing the
                app restores access). The matrix is read-only and collapsed by
                default to keep the editor focused on installed surfaces. */}
            {inactiveModules.length > 0 && (
              <Collapsible open={showInactive} onOpenChange={setShowInactive}>
                <CollapsibleTrigger asChild>
                  <Button variant="ghost" size="sm" className="w-full justify-between border border-dashed">
                    <span className="flex items-center gap-2 text-muted-foreground">
                      <PackageX className="h-4 w-4" />
                      Inactive apps ({inactiveModules.length}) — install the app to edit
                    </span>
                    <ChevronDown className={`h-4 w-4 transition-transform ${showInactive ? "rotate-180" : ""}`} />
                  </Button>
                </CollapsibleTrigger>
                <CollapsibleContent>
                  <div className="border rounded-lg overflow-x-auto mt-2 opacity-60">
                    <table className="w-full text-sm min-w-[640px]">
                      <thead>
                        <tr className="bg-muted/50">
                          <th className="text-left p-3 font-medium">Module</th>
                          <th className="text-center p-2 font-medium w-16">Read</th>
                          <th className="text-center p-2 font-medium w-16">Create</th>
                          <th className="text-center p-2 font-medium w-16">Write</th>
                          <th className="text-center p-2 font-medium w-16">Delete</th>
                          <th className="text-center p-2 font-medium w-16">Approve</th>
                          <th className="text-center p-2 font-medium w-16">Post</th>
                          <th className="text-center p-2 font-medium w-16">Pay</th>
                          <th className="text-center p-2 font-medium w-16">Export</th>
                          <th className="text-center p-2 font-medium w-20">Override</th>
                        </tr>
                      </thead>
                      <tbody>
                        {inactiveModules.map(mod => (
                          <tr key={mod} className="border-t">
                            <td className="p-3 font-medium flex items-center gap-2">
                              {MODULE_LABELS[mod]}
                              <Badge variant="outline" className="text-[10px]">App not installed</Badge>
                            </td>
                            {FLAG_FIELDS.map(field => (
                              <td key={field} className="text-center p-2">
                                <Checkbox checked={formData.rules[mod][field]} disabled />
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </CollapsibleContent>
              </Collapsible>
            )}
          </div>

          <DialogFooter>
            <Button variant="outline" onClick={() => setShowForm(false)}>Cancel</Button>
            <Button
              onClick={handleSave}
              disabled={!formData.name.trim() || createGroup.isPending || updateGroup.isPending}
            >
              {(createGroup.isPending || updateGroup.isPending) && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              {editingGroup ? "Save Changes" : "Create Group"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Delete Confirmation */}
      <AlertDialog open={!!deleteTarget} onOpenChange={() => setDeleteTarget(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete Access Group</AlertDialogTitle>
            <AlertDialogDescription>
              Are you sure you want to delete "{deleteTarget?.name}"? Members assigned to this group will lose its permissions.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction onClick={handleDelete}>Delete</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
