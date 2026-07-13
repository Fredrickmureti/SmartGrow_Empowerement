/**
 * AdminTeamMemberEditPage — workspace at
 * `/admin-management/team/:id/edit`. Replaces the legacy inline
 * "Country Scopes" `<Dialog>` from `src/pages/admin/AdminTeam.tsx`
 * and consolidates member-scope + group assignments into one page.
 */
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Section, LoadingState } from "@/design-system";
import { AdminRecordForm, AdminFieldCell } from "@/apps/platform-admin";
import { Checkbox } from "@/components/ui/checkbox";
import { Badge } from "@/components/ui/badge";
import { Label } from "@/components/ui/label";
import { usePlatformTeam } from "@/hooks/usePlatformTeam";
import { usePlatformGroups } from "@/hooks/usePlatformGroups";
import { useCountryScopes } from "@/hooks/useCountryScopes";
import { useCountries } from "@/hooks/useCountries";

const LIST_PATH = "/admin-management/team";

export default function AdminTeamMemberEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { admins, isLoading, fetchTeam, updateAdminGroups } = usePlatformTeam();
  const { groups, fetchGroups } = usePlatformGroups();
  const { scopes, fetchScopes, updateScopes } = useCountryScopes();
  const { countries } = useCountries();

  const [selectedGroups, setSelectedGroups] = useState<string[]>([]);
  const [selectedCountries, setSelectedCountries] = useState<string[]>([]);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [hydrated, setHydrated] = useState(false);

  const admin = useMemo(() => admins.find((a) => a.id === id) ?? null, [admins, id]);

  useEffect(() => {
    fetchTeam();
    fetchGroups();
    fetchScopes();
  }, [fetchTeam, fetchGroups, fetchScopes]);

  useEffect(() => {
    if (admin && !hydrated) {
      setSelectedGroups((admin.groups ?? []).map((g: any) => g.id));
      setSelectedCountries(
        scopes.filter((s) => s.admin_id === admin.id).map((s) => s.country_code),
      );
      setHydrated(true);
    }
  }, [admin, scopes, hydrated]);

  const handleSubmit = async (e: FormEvent<HTMLFormElement>) => {
    e.preventDefault();
    if (!admin) return;
    setIsSubmitting(true);
    try {
      await Promise.all([
        updateAdminGroups(admin.id, selectedGroups),
        updateScopes(admin.id, selectedCountries),
      ]);
      navigate(LIST_PATH);
    } finally {
      setIsSubmitting(false);
    }
  };

  if (isLoading && !admin) return <LoadingState />;
  if (!admin) {
    navigate(LIST_PATH, { replace: true });
    return null;
  }

  const toggleGroup = (gid: string, checked: boolean) =>
    setSelectedGroups((prev) =>
      checked ? [...prev, gid] : prev.filter((g) => g !== gid),
    );

  const toggleCountry = (code: string, checked: boolean) =>
    setSelectedCountries((prev) =>
      checked ? [...prev, code] : prev.filter((c) => c !== code),
    );

  return (
    <AdminRecordForm
      mode="edit"
      entityLabel="Team member"
      recordRef={admin.full_name || admin.email}
      meta={`${admin.role} · ${admin.email}`}
      cancelHref={LIST_PATH}
      onSubmit={handleSubmit}
      isSubmitting={isSubmitting}
      submitLabel="Save changes"
    >
      <Section title="Access groups" description="Groups this member inherits permissions from.">
        <AdminFieldCell span={2}>
          <div className="space-y-2 max-h-64 overflow-y-auto border rounded-md p-3">
            {groups.length === 0 ? (
              <p className="text-sm text-muted-foreground">No groups defined.</p>
            ) : (
              groups.map((g) => (
                <label key={g.id} className="flex items-center gap-2 cursor-pointer">
                  <Checkbox
                    checked={selectedGroups.includes(g.id)}
                    onCheckedChange={(c) => toggleGroup(g.id, Boolean(c))}
                  />
                  <span className="text-sm">{g.name}</span>
                  {g.is_system && (
                    <Badge variant="outline" className="text-[10px]">System</Badge>
                  )}
                </label>
              ))
            )}
          </div>
        </AdminFieldCell>
      </Section>

      <Section
        title="Country scopes"
        description="Assign countries this operator can access. Operators with no countries assigned will have restricted access."
      >
        <AdminFieldCell span={2}>
          <div className="space-y-2 max-h-72 overflow-y-auto border rounded-md p-3">
            {countries.map((c) => (
              <label key={c.code} className="flex items-center gap-2 cursor-pointer">
                <Checkbox
                  checked={selectedCountries.includes(c.code)}
                  onCheckedChange={(v) => toggleCountry(c.code, Boolean(v))}
                />
                <span className="text-sm">{c.name}</span>
              </label>
            ))}
          </div>
          <p className="text-xs text-muted-foreground mt-2">
            <Label>Note</Label>: scope changes apply immediately on save.
          </p>
        </AdminFieldCell>
      </Section>
    </AdminRecordForm>
  );
}