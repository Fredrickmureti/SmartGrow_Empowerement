/**
 * AdminGroupForm — routed create/edit surface for platform admin
 * access groups. Replaces the legacy inline `<Dialog>` previously
 * mounted from `src/pages/admin/AdminGroups.tsx`, per the
 * Platform Admin four-pattern rule in
 * `docs/design-system/audit/platform-admin.md`.
 */
import { useEffect, useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { Section } from "@/design-system";
import { AdminRecordForm, AdminFieldGrid, AdminFieldCell } from "@/apps/platform-admin";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Loader2 } from "lucide-react";
import { usePlatformGroups, type PlatformGroup } from "@/hooks/usePlatformGroups";
import {
  usePlatformPermissionDefinitions,
  groupByCategory,
} from "@/hooks/usePlatformPermissionDefinitions";
import { useToast } from "@/hooks/use-toast";

interface AdminGroupFormProps {
  mode: "create" | "edit";
  group?: PlatformGroup | null;
}

const LIST_PATH = "/admin-management/groups";

export function AdminGroupForm({ mode, group }: AdminGroupFormProps) {
  const navigate = useNavigate();
  const { toast } = useToast();
  const { createGroup, updateGroup } = usePlatformGroups();
  const { data: permDefinitions, isLoading: defsLoading } =
    usePlatformPermissionDefinitions();

  const [name, setName] = useState(group?.name ?? "");
  const [description, setDescription] = useState(group?.description ?? "");
  const [selectedPerms, setSelectedPerms] = useState<string[]>(
    group?.permissions ?? [],
  );
  const [isSubmitting, setIsSubmitting] = useState(false);

  // Sync when the loaded group arrives (edit page fetches async).
  useEffect(() => {
    if (mode === "edit" && group) {
      setName(group.name);
      setDescription(group.description ?? "");
      setSelectedPerms(group.permissions);
    }
  }, [group, mode]);

  const categories = permDefinitions ? groupByCategory(permDefinitions) : {};

  const togglePerm = (key: string) =>
    setSelectedPerms((prev) =>
      prev.includes(key) ? prev.filter((p) => p !== key) : [...prev, key],
    );

  const toggleCategory = (keys: string[]) => {
    const allSelected = keys.every((k) => selectedPerms.includes(k));
    if (allSelected) {
      setSelectedPerms((prev) => prev.filter((p) => !keys.includes(p)));
    } else {
      setSelectedPerms((prev) => Array.from(new Set([...prev, ...keys])));
    }
  };

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!name.trim()) {
      toast({ title: "Name is required", variant: "destructive" });
      return;
    }
    setIsSubmitting(true);
    try {
      if (mode === "edit" && group) {
        await updateGroup(group.id, name.trim(), description, selectedPerms);
      } else {
        await createGroup(name.trim(), description, selectedPerms);
      }
      navigate(LIST_PATH);
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <AdminRecordForm
      mode={mode}
      entityLabel="Access group"
      recordRef={group?.name}
      meta={
        mode === "edit"
          ? "Update group name, description, and permissions."
          : "Define a new access group with specific permissions."
      }
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel={mode === "edit" ? "Save changes" : "Create group"}
    >
      <Section
        title="Identity"
        description="How this group appears to platform operators."
      >
        <AdminFieldGrid columns={2}>
          <div className="space-y-2">
            <Label htmlFor="group-name">Name *</Label>
            <Input
              id="group-name"
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="e.g. Marketing Team"
              required
            />
          </div>
          <AdminFieldCell span={2}>
            <div className="space-y-2">
              <Label htmlFor="group-description">Description</Label>
              <Textarea
                id="group-description"
                value={description}
                onChange={(e) => setDescription(e.target.value)}
                placeholder="What this group has access to..."
                rows={2}
              />
            </div>
          </AdminFieldCell>
        </AdminFieldGrid>
      </Section>

      <Section
        title="Permissions"
        description="Select the platform capabilities members of this group inherit."
      >
        {defsLoading ? (
          <div className="flex items-center gap-2 text-sm text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" /> Loading permissions...
          </div>
        ) : (
          <div className="space-y-3">
            {Object.entries(categories).map(([category, defs]) => {
              const keys = defs.map((d) => d.key);
              const allSelected = keys.every((k) => selectedPerms.includes(k));
              const someSelected = keys.some((k) => selectedPerms.includes(k));
              return (
                <div
                  key={category}
                  className="border rounded-md p-3 space-y-2"
                >
                  <div className="flex items-center gap-2">
                    <Checkbox
                      checked={allSelected}
                      ref={(el) => {
                        if (el && someSelected && !allSelected)
                          (el as any).indeterminate = true;
                      }}
                      onCheckedChange={() => toggleCategory(keys)}
                    />
                    <span className="text-sm font-medium">{category}</span>
                  </div>
                  <div className="ml-6 grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                    {defs.map((def) => (
                      <label
                        key={def.key}
                        className="flex items-start gap-2 cursor-pointer"
                      >
                        <Checkbox
                          checked={selectedPerms.includes(def.key)}
                          onCheckedChange={() => togglePerm(def.key)}
                        />
                        <span className="text-xs leading-tight">
                          {def.label}
                          {def.description && (
                            <span className="text-[10px] text-muted-foreground ml-1">
                              — {def.description}
                            </span>
                          )}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </Section>
    </AdminRecordForm>
  );
}

export default AdminGroupForm;