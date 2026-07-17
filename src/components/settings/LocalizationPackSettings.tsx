import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Package, Globe, Check } from "lucide-react";
import { adminFrom } from "@/lib/adminClient";
import { supabase } from "@/integrations/supabase/client";
import { NotAuthenticatedError } from "@/integrations/supabase/invokeWithAuth";
import { invokeLocalizationPack } from "@/integrations/supabase/invokeLocalizationPack";
import { toast } from "sonner";
import { useBusinesses } from "@/hooks/useBusinesses";
import { TenantReadinessGate } from "@/components/onboarding/TenantReadinessGate";
import { formatInstallerError } from "@/features/localization/lib/installerError";
import { isAlreadyInstalledError } from "@/features/localization/lib/installerError";

interface InstalledPack {
  id: string;
  pack_id: string;
  pack_version: string;
  installed_at: string;
  pack_name?: string;
  pack_description?: string | null;
  latest_version?: string;
}

interface AvailablePack {
  id: string;
  name: string;
  description: string | null;
  version: string;
  country_code: string;
}

export function LocalizationPackSettings() {
  const { currentBusiness } = useBusinesses();
  const [installedPack, setInstalledPack] = useState<InstalledPack | null>(null);
  const [availablePack, setAvailablePack] = useState<AvailablePack | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isInstalling, setIsInstalling] = useState(false);

  useEffect(() => {
    if (currentBusiness?.id) {
      fetchPackStatus();
    } else {
      setInstalledPack(null);
      setAvailablePack(null);
      setIsLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [currentBusiness?.id]);

  const fetchPackStatus = async () => {
    if (!currentBusiness?.id) return;
    setIsLoading(true);
    setInstalledPack(null);
    setAvailablePack(null);

    try {
      // Localization is now scoped to the Company (Business), not the Org.
      const { data: installed } = await adminFrom("installed_localization_packs")
        .select("id, pack_id, pack_version, installed_at")
        .eq("business_id", currentBusiness.id)
        .limit(1)
        .maybeSingle();

      if (installed) {
        const { data: packDetails } = await adminFrom("localization_packs")
          .select("name, description, version")
          .eq("id", installed.pack_id)
          .maybeSingle();

        setInstalledPack({
          ...installed,
          pack_name: packDetails?.name,
          pack_description: packDetails?.description,
          latest_version: packDetails?.version,
        });
      }

      const businessCountry = currentBusiness?.country;
      if (businessCountry && !installed) {
        const { data: available } = await adminFrom("localization_packs")
          .select("id, name, description, version, country_code")
          .eq("country_code", businessCountry)
          .eq("is_active", true)
          .eq("is_published", true)
          .limit(1)
          .maybeSingle();

        if (available) {
          setAvailablePack(available as AvailablePack);
        }
      }
    } catch (err) {
      console.error("Error fetching pack status:", err);
    } finally {
      setIsLoading(false);
    }
  };

  const handleInstall = async () => {
    if (!availablePack || !currentBusiness?.id) return;
    setIsInstalling(true);

    try {
      const { data, error } = await invokeWithAuth(
        "install-localization-pack",
        {
          body: {
            business_id: currentBusiness.id,
            organization_id: currentBusiness.organization_id,
            pack_id: availablePack.id,
          },
        }
      );

      if (error) {
        if (isAlreadyInstalledError(error)) {
          const { title, description } = formatInstallerError(error);
          toast.info(title, { description });
          await fetchPackStatus();
          return;
        }
        const { title, description } = formatInstallerError(error);
        toast.error(title, { description });
        return;
      }

      toast.success((data as { message?: string } | null)?.message || "Localization pack installed!");
      await fetchPackStatus();
    } catch (err) {
      if (err instanceof NotAuthenticatedError) {
        toast.error("Your session expired. Please sign in again.");
      } else if (isAlreadyInstalledError(err)) {
        const { title, description } = formatInstallerError(err);
        toast.info(title, { description });
        await fetchPackStatus();
      } else {
        const { title, description } = formatInstallerError(err);
        toast.error(title, { description });
      }
    } finally {
      setIsInstalling(false);
    }
  };

  if (!currentBusiness) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <p className="text-sm text-muted-foreground">Select a Company to view its localization pack.</p>
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Globe className="h-5 w-5" />
          Localization Pack
        </CardTitle>
        <CardDescription>
          Country-specific tax rates and chart of accounts for <span className="font-medium">{currentBusiness.name}</span>
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        {installedPack ? (
          <div className="rounded-lg border p-4 space-y-2">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Check className="h-4 w-4 text-primary" />
                <span className="font-medium">{installedPack.pack_name || "Localization Pack"}</span>
              </div>
              <Badge variant="outline">v{installedPack.pack_version}</Badge>
            </div>
            {installedPack.pack_description && (
              <p className="text-sm text-muted-foreground">{installedPack.pack_description}</p>
            )}
            <p className="text-xs text-muted-foreground">
              Installed on {new Date(installedPack.installed_at).toLocaleDateString()}
            </p>
            {installedPack.latest_version && installedPack.latest_version !== installedPack.pack_version && (
              <p className="text-xs text-amber-600">
                Update available: v{installedPack.latest_version}
              </p>
            )}
          </div>
        ) : availablePack ? (
          <div className="rounded-lg border p-4 space-y-3">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Package className="h-4 w-4 text-primary" />
                <span className="font-medium">{availablePack.name}</span>
              </div>
              <Badge variant="outline">v{availablePack.version}</Badge>
            </div>
            {availablePack.description && (
              <p className="text-sm text-muted-foreground">{availablePack.description}</p>
            )}
            <div className="text-xs text-muted-foreground">
              <p>This will apply country-specific tax rates and chart of accounts to <span className="font-medium">{currentBusiness.name}</span>.</p>
              <p className="italic mt-1">All values are editable after installation.</p>
            </div>
            <TenantReadinessGate compact>
              <Button onClick={handleInstall} disabled={isInstalling} size="sm">
                {isInstalling ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Installing...
                  </>
                ) : (
                  <>
                    <Package className="mr-2 h-4 w-4" />
                    Install Pack
                  </>
                )}
              </Button>
            </TenantReadinessGate>
          </div>
        ) : (
          <div className="rounded-lg border border-dashed p-4 text-center">
            <Globe className="h-8 w-8 text-muted-foreground mx-auto mb-2" />
            <p className="text-sm text-muted-foreground">
              No localization pack available for this Company's country.
            </p>
            <p className="text-xs text-muted-foreground mt-1">
              {currentBusiness.name} is configured with a standard chart of accounts and tax rates.
              You can customize them anytime in the Tax and Businesses settings.
            </p>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
