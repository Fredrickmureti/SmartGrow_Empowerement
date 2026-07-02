import { normalizeError } from "@/services/resilience";
/**
 * AdminLocalizationPacks — platform/admin entry point for localization-pack
 * maintenance. The actual editing surface (rules, templates, version
 * timeline, diff, audit, health) lives in the shared `<PackEditorShell />`
 * so admin and tenant editors stay byte-for-byte aligned.
 *
 * This page owns ONLY platform-admin concerns:
 *   - country-scoped pack listing
 *   - install-count stats
 *   - "Create pack" + publish-toggle (admin-privileged shortcuts)
 *   - opening the shared shell scoped to the chosen pack
 */
import { useMemo, useState } from "react";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle,
} from "@/components/ui/dialog";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { adminFrom } from "@/lib/adminClient";
import { usePlatformPermissions } from "@/hooks/usePlatformPermissions";
import { useCountries } from "@/hooks/useCountries";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { toast } from "sonner";
import { Globe, Plus, Loader2, Package, Pencil } from "lucide-react";
import { PackEditorShell } from "@/features/localization";

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
  const { countries } = useCountries();
  const { data: packs, isLoading } = usePacks();
  const { data: installStats } = useInstallStats();
  const { countryScopes, isGlobalAccess } = usePlatformPermissions();

  const [selectedPack, setSelectedPack] = useState<LocalizationPack | null>(null);
  const [showCreate, setShowCreate] = useState(false);

  const countryMap = useMemo(() => new Map(countries.map((c) => [c.code, c.name])), [countries]);
  const filtered = (packs ?? []).filter((p) => isGlobalAccess || countryScopes.includes(p.country_code));

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
          <Button onClick={() => setShowCreate(true)} size="sm">
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
              <Button size="sm" onClick={() => setShowCreate(true)}>
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
                      <Button size="sm" variant="outline" onClick={() => setSelectedPack(p)}>
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

      {showCreate && (
        <CreatePackDialog countries={countries} onClose={() => setShowCreate(false)} />
      )}

      <Sheet open={!!selectedPack} onOpenChange={(o) => !o && setSelectedPack(null)}>
        <SheetContent side="right" className="w-full sm:max-w-[1100px] sm:w-[95vw] overflow-y-auto">
          <SheetHeader>
            <SheetTitle className="flex items-center gap-2">
              <Package className="h-4 w-4" />
              {selectedPack?.name} <Badge variant="outline" className="ml-1">v{selectedPack?.version}</Badge>
            </SheetTitle>
          </SheetHeader>
          {selectedPack && (
            <div className="mt-4">
              <PackEditorShell mode="admin" packId={selectedPack.id} />
            </div>
          )}
        </SheetContent>
      </Sheet>
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

function CreatePackDialog({
  countries,
  onClose,
}: {
  countries: { code: string; name: string; currency: string }[];
  onClose: () => void;
}) {
  const queryClient = useQueryClient();
  const [countryCode, setCountryCode] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [version, setVersion] = useState("1.0.0");
  const [busy, setBusy] = useState(false);

  const handleSubmit = async () => {
    if (!countryCode || !name) return;
    setBusy(true);
    const { error } = await adminFrom("localization_packs").insert({
      country_code: countryCode,
      name,
      description: description || null,
      version,
      is_active: true,
      is_published: false,
    });
    if (error) toast.error(`Failed: ${normalizeError(error).message}`);
    else {
      toast.success("Localization pack created");
      queryClient.invalidateQueries({ queryKey: ["admin-localization-packs"] });
      onClose();
    }
    setBusy(false);
  };

  return (
    <Dialog open onOpenChange={onClose}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Create localization pack</DialogTitle>
          <DialogDescription>New country-specific fiscal configuration pack.</DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-2">
            <Label>Country *</Label>
            <Select value={countryCode} onValueChange={(v) => {
              setCountryCode(v);
              const c = countries.find((x) => x.code === v);
              if (c && !name) setName(`${c.name} Fiscal Localization`);
            }}>
              <SelectTrigger><SelectValue placeholder="Select country" /></SelectTrigger>
              <SelectContent>
                {countries.map((c) => (
                  <SelectItem key={c.code} value={c.code}>{c.name} ({c.currency})</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-2">
            <Label>Pack name *</Label>
            <Input value={name} onChange={(e) => setName(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Description</Label>
            <Textarea value={description} onChange={(e) => setDescription(e.target.value)} />
          </div>
          <div className="space-y-2">
            <Label>Initial version</Label>
            <Input value={version} onChange={(e) => setVersion(e.target.value)} />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>Cancel</Button>
          <Button onClick={handleSubmit} disabled={busy || !countryCode || !name}>
            {busy && <Loader2 className="h-4 w-4 animate-spin mr-2" />}Create pack
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
