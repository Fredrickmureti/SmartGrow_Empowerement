import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { usePOSEtims } from "@/hooks/pos/usePOSEtims";
import { FileCheck2, Loader2 } from "lucide-react";

export function EtimsSettingsCard() {
  const { etimsSettings, isLoading, updateEtimsSettings } = usePOSEtims();
  const isUpdating = updateEtimsSettings.isPending;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-12">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const handleToggle = async (field: string, value: boolean) => {
    await updateEtimsSettings.mutateAsync({ [field]: value });
  };

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileCheck2 className="h-5 w-5" />
            eTIMS Tax Compliance
          </CardTitle>
          <CardDescription>
            Configure Kenya Revenue Authority eTIMS integration for this POS
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Enable eTIMS</Label>
              <p className="text-sm text-muted-foreground">
                Transmit sales to KRA for tax compliance
              </p>
            </div>
            <Switch
              checked={etimsSettings.etims_enabled || false}
              onCheckedChange={(checked) => handleToggle("etims_enabled", checked)}
              disabled={isUpdating}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Auto-Transmit After Sale</Label>
              <p className="text-sm text-muted-foreground">
                Automatically send to eTIMS when a sale completes
              </p>
            </div>
            <Switch
              checked={etimsSettings.etims_auto_transmit || false}
              onCheckedChange={(checked) => handleToggle("etims_auto_transmit", checked)}
              disabled={isUpdating || !etimsSettings.etims_enabled}
            />
          </div>

          <div className="flex items-center justify-between">
            <div className="space-y-0.5">
              <Label>Require Customer TIN for B2B</Label>
              <p className="text-sm text-muted-foreground">
                Prompt for Tax Identification Number on business sales
              </p>
            </div>
            <Switch
              checked={etimsSettings.customer_tin_required || false}
              onCheckedChange={(checked) => handleToggle("customer_tin_required", checked)}
              disabled={isUpdating || !etimsSettings.etims_enabled}
            />
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>About eTIMS</CardTitle>
        </CardHeader>
        <CardContent>
          <div className="space-y-4 text-sm">
            <p>
              eTIMS (electronic Tax Invoice Management System) is Kenya's digital tax 
              compliance system managed by the Kenya Revenue Authority (KRA).
            </p>
            <div className="space-y-2">
              <p className="font-medium">When enabled, the system will:</p>
              <ul className="list-disc list-inside space-y-1 text-muted-foreground">
                <li>Generate a unique Control Unit (CU) number for each sale</li>
                <li>Create a QR code that links to KRA verification</li>
                <li>Store transmission status and retry failed attempts</li>
                <li>Include eTIMS data on printed receipts</li>
              </ul>
            </div>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
