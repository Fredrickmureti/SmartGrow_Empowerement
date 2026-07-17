import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Loader2, Package, Globe, Check, SkipForward } from "lucide-react";
import { adminFrom } from "@/lib/adminClient";
import { supabase } from "@/integrations/supabase/client";
import { NotAuthenticatedError } from "@/integrations/supabase/invokeWithAuth";
import { invokeLocalizationPack } from "@/integrations/supabase/invokeLocalizationPack";
import { formatInstallerError, isAlreadyInstalledError } from "@/features/localization/lib/installerError";
import { toast } from "sonner";

interface LocalizationPackPromptProps {
  countryCode: string;
  organizationId: string;
  onComplete: () => void;
  onSkip: () => void;
}

interface AvailablePack {
  id: string;
  name: string;
  description: string | null;
  version: string;
  country_code: string;
}

export function LocalizationPackPrompt({
  countryCode,
  organizationId,
  onComplete,
  onSkip,
}: LocalizationPackPromptProps) {
  const [pack, setPack] = useState<AvailablePack | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [isInstalling, setIsInstalling] = useState(false);
  const [installed, setInstalled] = useState(false);

  useEffect(() => {
    async function fetchPack() {
      if (!countryCode) {
        setIsLoading(false);
        return;
      }

      const { data, error } = await adminFrom("localization_packs")
        .select("id, name, description, version, country_code")
        .eq("country_code", countryCode)
        .eq("is_active", true)
        .eq("is_published", true)
        .limit(1)
        .maybeSingle();

      if (!error && data) {
        setPack(data as AvailablePack);
      }
      setIsLoading(false);
    }

    fetchPack();
  }, [countryCode]);

  const handleInstall = async () => {
    if (!pack || !organizationId) return;
    setIsInstalling(true);

    try {
      const { data, error } = await invokeWithAuth(
        "install-localization-pack",
        {
          body: { organization_id: organizationId, pack_id: pack.id },
        }
      );

      if (error) {
        console.error("Install error:", error);
        if (isAlreadyInstalledError(error)) {
          const { title, description } = formatInstallerError(error);
          toast.info(title, { description });
          setInstalled(true);
          setTimeout(() => onComplete(), 1500);
          return;
        }
        const { title, description } = formatInstallerError(error);
        toast.error(title, { description });
        setIsInstalling(false);
        return;
      }

      setInstalled(true);
      toast.success((data as { message?: string } | null)?.message || "Localization pack installed!");

      setTimeout(() => {
        onComplete();
      }, 1500);
    } catch (err) {
      console.error("Install error:", err);
      if (err instanceof NotAuthenticatedError) {
        toast.error("Your session expired. Please sign in again.");
        setIsInstalling(false);
      } else if (isAlreadyInstalledError(err)) {
        const { title, description } = formatInstallerError(err);
        toast.info(title, { description });
        setInstalled(true);
        setTimeout(() => onComplete(), 1500);
      } else {
        const { title, description } = formatInstallerError(err);
        toast.error(title, { description });
        setIsInstalling(false);
      }
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  // No pack available — auto-skip
  if (!pack) {
    return (
      <Card className="w-full max-w-lg mx-auto">
        <CardContent className="flex flex-col items-center py-8">
          <Globe className="h-12 w-12 text-muted-foreground mb-4" />
          <h3 className="text-lg font-medium mb-2">No country-specific template found</h3>
          <p className="text-sm text-muted-foreground text-center mb-6">
            Your workspace has been set up with a standard chart of accounts and tax rates.
            You can customize them anytime in Settings.
          </p>
          <Button onClick={onSkip}>
            Continue
          </Button>
        </CardContent>
      </Card>
    );
  }

  // Pack installed successfully
  if (installed) {
    return (
      <Card className="w-full max-w-lg mx-auto">
        <CardContent className="flex flex-col items-center py-8">
          <div className="w-16 h-16 rounded-full bg-primary/10 flex items-center justify-center mb-4">
            <Check className="h-8 w-8 text-primary" />
          </div>
          <h3 className="text-lg font-medium mb-2">Pack Installed!</h3>
          <p className="text-sm text-muted-foreground">
            Your workspace has been pre-configured. Redirecting...
          </p>
        </CardContent>
      </Card>
    );
  }

  return (
    <Card className="w-full max-w-lg mx-auto">
      <CardHeader className="text-center pb-2">
        <div className="w-16 h-16 rounded-2xl bg-primary/10 flex items-center justify-center mx-auto mb-4">
          <Package className="w-8 h-8 text-primary" />
        </div>
        <CardTitle className="text-xl">Country-Specific Configuration</CardTitle>
        <CardDescription className="text-base">
          We have a pre-built tax and accounts template for your country
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-lg border p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h4 className="font-medium">{pack.name}</h4>
            <Badge variant="outline">v{pack.version}</Badge>
          </div>
          {pack.description && (
            <p className="text-sm text-muted-foreground">{pack.description}</p>
          )}
          <div className="text-xs text-muted-foreground space-y-1">
            <p>This will apply:</p>
            <ul className="list-disc list-inside space-y-0.5">
              <li>Country-specific tax rates</li>
              <li>Localized chart of accounts</li>
            </ul>
            <p className="mt-2 italic">
              You can customize everything later in Settings.
            </p>
          </div>
        </div>

        <div className="flex flex-col gap-3">
          <Button
            className="w-full h-11"
            onClick={handleInstall}
            disabled={isInstalling}
          >
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
          <Button
            variant="ghost"
            className="w-full"
            onClick={onSkip}
            disabled={isInstalling}
          >
            <SkipForward className="mr-2 h-4 w-4" />
            Skip — I'll configure manually
          </Button>
        </div>
      </CardContent>
    </Card>
  );
}
