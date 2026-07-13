/**
 * AdminLocalizationPacks — platform/admin entry point for localization-pack
 * maintenance. The actual editing surface (rules, templates, version
 * timeline, diff, audit, health) lives in the shared `<PackEditorShell />`
 * so admin and tenant editors stay byte-for-byte aligned.
 *
 * This page owns ONLY platform-admin concerns:
 *   - country-scoped pack listing
 *   - install-count stats
 *   - "Create pack" (routes to workspace) + publish-toggle
 *   - opening the shared shell scoped to the chosen pack (routes to workspace)
 */
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { adminFrom } from "@/lib/adminClient";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { useCountries } from "@/hooks/useCountries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Globe, Plus, Loader2, Package, Pencil } from "lucide-react";

interface LocalizationPack {
  id: string;
  country_code: string;
  name: string;
  description: string | null;
  version: string;
  is_active: boolean;
  is_published: boolean;
  created_at: string;
  updated_at: string;
}

function usePacks() {
  return useQuery({
    queryKey: ["admin-localization-packs"],
    queryFn: async () => {
      const { data, error } = await adminFrom("localization_packs")
        .select("*")
        .order("country_code")
        .order("name");
      if (error) throw error;
      return (data ?? []) as LocalizationPack[];
    },
  });
}

function useInstallStats() {
  return useQuery({
    queryKey: ["pack-install-stats"],
    queryFn: async () => {
      const { data, error } = await adminFrom("installed_localization_packs").select("pack_id");
      if (error) throw error;
      const stats: Record<string, number> = {};
      (data ?? []).forEach((row: any) => {
        stats[row.pack_id] = (stats[row.pack_id] ?? 0) + 1;
      });
      return stats;
    },
  });
}

export default function AdminLocalizationPacks() {
  const navigate = useNavigate();
  const { countries } = useCountries();
  const { data: packs, isLoading } = usePacks();
  const { data: installStats } = useInstallStats();
  const { countryScopes, isGlobalAccess } = usePlatformPermissions();

  const countryMap = useMemo(() => new Map(countries.map((c) => [c.code, c.name])), [countries]);
  const filtered = (packs ?? []).filter((p) => isGlobalAccess || countryScopes.includes(p.country_code));

  const openCreate = () => navigate("/admin-management/localization-packs/new");
  const openEdit = (pack: LocalizationPack) =>
    navigate(`/admin-management/localization-packs/${pack.id}`);

  return (
    <>
      <div className="space-y-6 p-3 sm:p-6 lg:p-8">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h1 className="text-lg sm:text-2xl font-bold flex items-center gap-2">
              <Globe className="h-5 w-5" />
              Localization Packs
            </h1>
            <p className="text-xs sm:text-sm text-muted-foreground">
              Country-specific fiscal &amp; payroll configuration. Edits open the shared schema-validated editor.
            </p>
          </div>
          <Button onClick={openCreate} size="sm">
            <Plus className="h-3.5 w-3.5 mr-1.5" />Create pack
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-3 sm:gap-4">
          <Stat label="Packs" value={filtered.length} />
          <Stat label="Published" value={filtered.filter((p) => p.is_published).length} />
          <Stat label="Installations" value={Object.values(installStats ?? {}).reduce((a, b) => a + b, 0)} />
        </div>

        {isLoading ? (
          <div className="flex items-center justify-center py-12">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : filtered.length === 0 ? (
          <Card>
            <CardContent className="flex flex-col items-center justify-center py-12">
              <Package className="h-10 w-10 text-muted-foreground mb-3" />
              <h3 className="text-sm font-medium">No localization packs yet</h3>
              <p className="text-xs text-muted-foreground mb-4">Create your first pack to start configuring country defaults.</p>
              <Button size="sm" onClick={openCreate}>
                <Plus className="h-3.5 w-3.5 mr-1.5" />Create pack
              </Button>
            </CardContent>
          </Card>
        ) : (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
            {filtered.map((p) => (
              <Card key={p.id} className="hover:bg-muted/30 transition-colors">
                <CardContent className="p-4 space-y-3">
                  <div className="flex items-start justify-between gap-2">
                    <div className="min-w-0">
                      <div className="font-medium truncate">{p.name}</div>
                      <div className="text-xs text-muted-foreground">
                        {countryMap.get(p.country_code) ?? p.country_code}
                      </div>
                    </div>
                    <div className="flex flex-col items-end gap-1 shrink-0">
                      <Badge variant={p.is_published ? "default" : "secondary"} className="text-[10px]">
                        {p.is_published ? "Published" : "Draft"}
                      </Badge>
                      <Badge variant="outline" className="text-[10px]">v{p.version}</Badge>
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    <span className="text-[11px] text-muted-foreground">
                      {installStats?.[p.id] ?? 0} installations
                    </span>
                    <div className="flex items-center gap-2">
                      <PublishToggle pack={p} />
                      <Button size="sm" variant="outline" onClick={() => openEdit(p)}>
                        <Pencil className="h-3.5 w-3.5 mr-1" />Edit
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            ))}
          </div>
        )}
      </div>
    </>
  );
}

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent className="p-4 sm:pt-6 sm:p-6">
        <div className="text-xl sm:text-2xl font-bold">{value}</div>
        <p className="text-[11px] sm:text-sm text-muted-foreground">{label}</p>
      </CardContent>
    </Card>
  );
}

function PublishToggle({ pack }: { pack: LocalizationPack }) {
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const toggle = async () => {
    setBusy(true);
    const { error } = await adminFrom("localization_packs")
      .update({ is_published: !pack.is_published, updated_at: new Date().toISOString() })
      .eq("id", pack.id);
    if (error) toast.error("Failed to update");
    else {
      toast.success(pack.is_published ? "Pack unpublished" : "Pack published");
      queryClient.invalidateQueries({ queryKey: ["admin-localization-packs"] });
    }
    setBusy(false);
  };
  return <Switch checked={pack.is_published} onCheckedChange={toggle} disabled={busy} />;
}
