import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { useReceiptSettings } from "@/hooks/useReceiptSettings";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useDocumentBranding } from "@/hooks/useDocumentBranding";
import { useBranch } from "@/contexts/BranchContext";
import { useCurrency } from "@/hooks/useCurrency";
import { Loader2, Receipt, Printer, FileText, Smartphone, Send } from "lucide-react";
import { ReceiptSectionEditor } from "./ReceiptSectionEditor";
import { ReceiptLivePreview } from "./ReceiptLivePreview";
import type { ExtendedReceiptSettings, PaperSize, ReceiptTemplate, FontSize, LineSpacing, LogoSize } from "@/types/receipt";
import { PAPER_CONFIGS, TEMPLATE_PRESETS, applyTemplatePreset } from "@/lib/receiptConfig";
import { useTestPrintReceipt } from "@/hooks/pos/useTestPrintReceipt";
import { usePrinterProfiles } from "@/hooks/usePrinterProfiles";
import { ResolvedPrintPolicyPanel } from "./ResolvedPrintPolicyPanel";

export function ReceiptSettings() {
  const { settings, isLoading, updateSettings, isUpdating } = useReceiptSettings();
  const { currentBusiness } = useBusinesses();
  // Pass branchId so the in-settings preview reflects branch overrides
  // (logo, prefix, header/footer) when a branch is currently selected.
  const { currentBranch } = useBranch();
  const { branding } = useDocumentBranding(currentBusiness?.id ?? null, currentBranch?.id ?? null);
  const { formatCurrency } = useCurrency();
  const { sendTestPrint, isPrinting, lastResolved } = useTestPrintReceipt();
  // Receipt overhaul Phase 2 — let the operator pick which physical printer
  // profile the test print should resolve through. Default to the first
  // active thermal-capable profile so a single-printer shop works zero-conf.
  const { activeProfiles } = usePrinterProfiles(currentBusiness?.id ?? null);
  const thermalProfiles = activeProfiles.filter((p) =>
    p.paper_format === "80mm" || p.paper_format === "58mm" || p.paper_format === "40mm"
  );
  const [selectedProfileId, setSelectedProfileId] = useState<string>("");
  const effectiveProfileId = selectedProfileId || thermalProfiles[0]?.id || "";

  const [localSettings, setLocalSettings] = useState<ExtendedReceiptSettings>(settings);
  const [hasChanges, setHasChanges] = useState(false);

  const handleTestPrint = () => {
    sendTestPrint({
      printerProfileId: effectiveProfileId || null,
      receiptSettings: localSettings,
      branding: {
        name: branding?.legal_name || branding?.name || currentBusiness?.name || "Your Company",
        legal_name: branding?.legal_name ?? null,
        logo_url: branding?.logo_url ?? null,
        email: branding?.email ?? null,
        phone: branding?.phone ?? null,
        address: branding?.address ?? null,
        city: branding?.city ?? null,
        state: branding?.state ?? null,
        postal_code: branding?.postal_code ?? null,
        country: branding?.country ?? null,
        tax_id: branding?.tax_id ?? null,
        base_currency: branding?.base_currency ?? null,
        timezone: (branding as any)?.timezone ?? null,
      },
    }).catch(() => undefined);
  };

  useEffect(() => {
    setLocalSettings(settings);
  }, [settings]);

  useEffect(() => {
    const changed = JSON.stringify(localSettings) !== JSON.stringify(settings);
    setHasChanges(changed);
  }, [localSettings, settings]);

  const handleChange = <K extends keyof ExtendedReceiptSettings>(
    key: K, 
    value: ExtendedReceiptSettings[K]
  ) => {
    setLocalSettings((prev) => ({ ...prev, [key]: value }));
  };

  const handleTemplateChange = (template: ReceiptTemplate) => {
    handleChange('template', template);
    if (template !== 'custom') {
      setLocalSettings((prev) => applyTemplatePreset(prev, template));
    }
  };

  const handleSave = () => {
    updateSettings(localSettings);
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center p-8">
        <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const paperConfig = PAPER_CONFIGS[localSettings.paper_size];

  return (
    <div className="space-y-6">
      {/* Paper Size & Layout Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Printer className="h-5 w-5" />
            Paper Size & Layout
          </CardTitle>
          <CardDescription>
            These settings apply to all receipts across the system. POS terminals may override specific settings like paper size and auto-print
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {/* Paper Size Selection */}
          <div className="space-y-3">
            <Label className="text-base font-medium">Paper Size</Label>
            <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
              {(Object.keys(PAPER_CONFIGS) as PaperSize[]).map((size) => {
                const config = PAPER_CONFIGS[size];
                return (
                  <Button
                    key={size}
                    variant={localSettings.paper_size === size ? "default" : "outline"}
                    className="flex flex-col h-auto py-3 gap-1"
                    onClick={() => handleChange('paper_size', size)}
                  >
                    {config.isThermal ? (
                      <Smartphone className="h-4 w-4" />
                    ) : (
                      <FileText className="h-4 w-4" />
                    )}
                    <span className="text-sm font-medium">{size}</span>
                    <span className="text-xs text-muted-foreground">
                      {config.columns} cols
                    </span>
                  </Button>
                );
              })}
            </div>
            <p className="text-sm text-muted-foreground">
              {paperConfig.isThermal ? 'Thermal receipt paper' : 'Standard paper'} • {paperConfig.columns} characters per line
            </p>
          </div>

          <Separator />

          {/* Template Selection */}
          <div className="space-y-3">
            <Label className="text-base font-medium">Template Preset</Label>
            <ToggleGroup
              type="single"
              value={localSettings.template}
              onValueChange={(value) => value && handleTemplateChange(value as ReceiptTemplate)}
              className="justify-start flex-wrap"
            >
              <ToggleGroupItem value="minimal" className="px-4">
                Minimal
              </ToggleGroupItem>
              <ToggleGroupItem value="standard" className="px-4">
                Standard
              </ToggleGroupItem>
              <ToggleGroupItem value="detailed" className="px-4">
                Detailed
              </ToggleGroupItem>
              <ToggleGroupItem value="custom" className="px-4">
                Custom
              </ToggleGroupItem>
            </ToggleGroup>
            <p className="text-sm text-muted-foreground">
              {localSettings.template === 'minimal' && 'Shows only essential transaction info'}
              {localSettings.template === 'standard' && 'Balanced view with key details'}
              {localSettings.template === 'detailed' && 'Full transaction breakdown with all fields'}
              {localSettings.template === 'custom' && 'Fully customized field visibility'}
            </p>
          </div>

          <Separator />

          {/* Typography Settings */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
            <div className="space-y-2">
              <Label>Font Size</Label>
              <Select
                value={localSettings.font_size}
                onValueChange={(value) => handleChange('font_size', value as FontSize)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">Small</SelectItem>
                  <SelectItem value="medium">Medium</SelectItem>
                  <SelectItem value="large">Large</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Line Spacing</Label>
              <Select
                value={localSettings.line_spacing}
                onValueChange={(value) => handleChange('line_spacing', value as LineSpacing)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="compact">Compact</SelectItem>
                  <SelectItem value="normal">Normal</SelectItem>
                  <SelectItem value="relaxed">Relaxed</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-2">
              <Label>Logo Size</Label>
              <Select
                value={localSettings.logo_size}
                onValueChange={(value) => handleChange('logo_size', value as LogoSize)}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="small">Small (40px)</SelectItem>
                  <SelectItem value="medium">Medium (60px)</SelectItem>
                  <SelectItem value="large">Large (80px)</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          <Separator />

          {/* Branding */}
          <div className="space-y-4">
            <h4 className="font-medium">Branding</h4>
            <div className="flex items-center justify-between">
              <div className="space-y-0.5">
                <Label htmlFor="show-logo">Show Company Logo</Label>
                <p className="text-sm text-muted-foreground">
                  Display the company logo at the top of receipts
                </p>
              </div>
              <Switch
                id="show-logo"
                checked={localSettings.show_logo}
                onCheckedChange={(checked) => handleChange("show_logo", checked)}
              />
            </div>
            
            <div className="space-y-2">
              <Label htmlFor="primary-color">Accent Color</Label>
              <div className="flex items-center gap-2">
                <Input
                  id="primary-color"
                  type="color"
                  value={localSettings.primary_color}
                  onChange={(e) => handleChange("primary_color", e.target.value)}
                  className="w-16 h-10 p-1 cursor-pointer"
                />
                <Input
                  value={localSettings.primary_color}
                  onChange={(e) => handleChange("primary_color", e.target.value)}
                  className="flex-1"
                  placeholder="#10b981"
                />
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      {/* Section Visibility Card */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Receipt className="h-5 w-5" />
            Receipt Sections
          </CardTitle>
          <CardDescription>
            Configure which sections and fields appear on receipts
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReceiptSectionEditor
            settings={localSettings}
            onChange={(key, value) => handleChange(key as keyof ExtendedReceiptSettings, value as ExtendedReceiptSettings[keyof ExtendedReceiptSettings])}
          />
        </CardContent>
      </Card>

      {/* Live Preview Card */}
      <Card>
        <CardHeader>
          <CardTitle>Live Preview</CardTitle>
          <CardDescription>
            See how your receipts will look with current settings
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReceiptLivePreview
            settings={localSettings}
            companyData={{
              name: branding?.legal_name || branding?.name || currentBusiness?.name || 'Your Company',
              logo_url: branding?.logo_url ?? null,
              address: branding?.address ?? null,
              city: branding?.city ?? null,
              phone: branding?.phone ?? null,
              email: branding?.email ?? null,
              tax_id: branding?.tax_id ?? null,
            }}
            formatCurrency={formatCurrency}
          />
        </CardContent>
      </Card>

      {/* Test print + diagnostics */}
      {thermalProfiles.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">Test Print Target</CardTitle>
            <CardDescription>
              Pick the physical printer profile the test print should resolve through.
              The server reports the actual paper, columns, and font it used so you can
              detect drift between the editor and the printer.
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
              <div className="space-y-1">
                <Label className="text-xs">Printer profile</Label>
                <Select
                  value={effectiveProfileId}
                  onValueChange={setSelectedProfileId}
                >
                  <SelectTrigger><SelectValue placeholder="Engine defaults" /></SelectTrigger>
                  <SelectContent>
                    {thermalProfiles.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.label} · {p.paper_format} · Font {p.font}
                        {p.columns_override ? ` · ${p.columns_override}c` : ""}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <ResolvedPrintPolicyPanel
              resolved={lastResolved}
              expectedColumns={null}
              profileLabel={(id) => thermalProfiles.find((p) => p.id === id)?.label ?? null}
            />
          </CardContent>
        </Card>
      )}

      {/* Save Button */}
      <div className="flex flex-col sm:flex-row sm:justify-end gap-2 sticky bottom-4 bg-background/80 backdrop-blur-sm p-4 rounded-lg border shadow-lg">
        <Button
          variant="outline"
          onClick={handleTestPrint}
          disabled={isPrinting}
          size="lg"
        >
          {isPrinting ? (
            <Loader2 className="mr-2 h-4 w-4 animate-spin" />
          ) : (
            <Send className="mr-2 h-4 w-4" />
          )}
          Send Test Print
        </Button>
        <Button onClick={handleSave} disabled={!hasChanges || isUpdating} size="lg">
          {isUpdating ? (
            <>
              <Loader2 className="mr-2 h-4 w-4 animate-spin" />
              Saving...
            </>
          ) : (
            "Save Receipt Settings"
          )}
        </Button>
      </div>
    </div>
  );
}