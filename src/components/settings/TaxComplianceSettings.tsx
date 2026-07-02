import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Separator } from "@/components/ui/separator";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { 
  useTaxCompliance, 
  useEtimsTransmissionLogs,
  SUPPORTED_TAX_COMPLIANCE_COUNTRIES 
} from "@/hooks/useTaxCompliance";
import { 
  Shield, 
  CheckCircle2, 
  XCircle, 
  Loader2, 
  RefreshCw, 
  AlertTriangle,
  Key,
  Server,
  Clock,
  FileText,
  Settings2,
  History,
  Info
} from "lucide-react";
import { format } from "date-fns";
import { ScrollArea } from "@/components/ui/scroll-area";

export function TaxComplianceSettings() {
  const {
    config,
    isLoading,
    isSaving,
    isInitializing,
    isComplianceAvailable,
    complianceInfo,
    businessCountry,
    isPlatformEtimsEnabled,
    platformEnvironment,
    saveConfig,
    initializeDevice,
    toggleActive,
    syncStandardCodes,
    refreshConfig,
  } = useTaxCompliance();

  const { logs, isLoading: isLoadingLogs } = useEtimsTransmissionLogs();

  const [tin, setTin] = useState("");
  const [bhfId, setBhfId] = useState("");
  const [isSyncing, setIsSyncing] = useState(false);

  useEffect(() => {
    if (config) {
      setTin(config.config?.tin || "");
      setBhfId(config.config?.bhf_id || "");
    }
  }, [config]);

  // Platform eTIMS not enabled
  if (!isPlatformEtimsEnabled) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Tax Compliance
          </CardTitle>
          <CardDescription>
            Electronic tax invoicing integration
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              eTIMS integration is not currently enabled on this platform. Please contact your administrator.
            </AlertDescription>
          </Alert>
        </CardContent>
      </Card>
    );
  }

  // Country not supported
  if (!isComplianceAvailable) {
    return (
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <Shield className="h-5 w-5" />
            Tax Compliance
          </CardTitle>
          <CardDescription>
            Electronic tax invoicing integration
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <Alert>
            <AlertTriangle className="h-4 w-4" />
            <AlertDescription>
              Tax compliance integration is not available for your current location ({businessCountry || "Not set"}).
              Currently supported countries: {Object.values(SUPPORTED_TAX_COMPLIANCE_COUNTRIES).map(c => c.name).join(", ")}.
            </AlertDescription>
          </Alert>
          {!businessCountry && (
            <Alert variant="default">
              <Settings2 className="h-4 w-4" />
              <AlertDescription>
                To enable tax compliance, please set your country in the <strong>Workspace</strong> tab above, 
                or in <strong>Companies</strong> settings if you have a company configured.
              </AlertDescription>
            </Alert>
          )}
        </CardContent>
      </Card>
    );
  }

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const handleSave = async () => {
    await saveConfig({
      tin,
      bhfId,
    });
  };

  const handleSync = async () => {
    setIsSyncing(true);
    await syncStandardCodes();
    setIsSyncing(false);
  };

  const isConfigured = config && config.config?.tin && config.config?.bhf_id;
  const isInitialized = config && config.config?.communication_key;
  const canActivate = isConfigured && isInitialized;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <Shield className="h-5 w-5" />
              {complianceInfo?.displayName}
            </CardTitle>
            <CardDescription>
              Connect your business to Kenya Revenue Authority for electronic invoicing
            </CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {config?.is_active ? (
              <Badge variant="default" className="bg-green-600">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                Active
              </Badge>
            ) : (
              <Badge variant="secondary">
                <XCircle className="h-3 w-3 mr-1" />
                Inactive
              </Badge>
            )}
            {platformEnvironment === "sandbox" && (
              <Badge variant="outline" className="text-amber-600 border-amber-500">
                Sandbox
              </Badge>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-6">
        {/* Environment Notice */}
        {platformEnvironment === "sandbox" && (
          <Alert>
            <Info className="h-4 w-4" />
            <AlertDescription>
              The platform is currently using the KRA sandbox environment for testing. Invoices will not be submitted to the live KRA system.
            </AlertDescription>
          </Alert>
        )}

        <Tabs defaultValue="credentials" className="w-full">
          <TabsList className="grid w-full grid-cols-3">
            <TabsTrigger value="credentials" className="gap-2">
              <Key className="h-4 w-4" />
              <span className="hidden sm:inline">Credentials</span>
            </TabsTrigger>
            <TabsTrigger value="device" className="gap-2">
              <Server className="h-4 w-4" />
              <span className="hidden sm:inline">Device</span>
            </TabsTrigger>
            <TabsTrigger value="logs" className="gap-2">
              <History className="h-4 w-4" />
              <span className="hidden sm:inline">Logs</span>
            </TabsTrigger>
          </TabsList>

          <TabsContent value="credentials" className="space-y-6 pt-4">
            {/* Guidance */}
            <Alert variant="default">
              <Info className="h-4 w-4" />
              <AlertDescription>
                Enter your business's KRA credentials below. Each business has its own unique KRA PIN and Branch ID.
              </AlertDescription>
            </Alert>

            {/* KRA Credentials */}
            <div className="space-y-4">
              <h4 className="font-medium flex items-center gap-2">
                <Key className="h-4 w-4" />
                Your Business KRA Credentials
              </h4>
              
              <div className="grid gap-4 sm:grid-cols-2">
                <div className="space-y-2">
                  <Label htmlFor="tin">KRA PIN (TIN)</Label>
                  <Input
                    id="tin"
                    value={tin}
                    onChange={(e) => setTin(e.target.value.toUpperCase())}
                    placeholder="A123456789B"
                    maxLength={11}
                  />
                  <p className="text-xs text-muted-foreground">
                    Your 11-character KRA PIN (e.g., A123456789B)
                  </p>
                </div>

                <div className="space-y-2">
                  <Label htmlFor="bhfId">Branch ID (BHF ID)</Label>
                  <Input
                    id="bhfId"
                    value={bhfId}
                    onChange={(e) => setBhfId(e.target.value)}
                    placeholder="00"
                    maxLength={2}
                  />
                  <p className="text-xs text-muted-foreground">
                    Use "00" for your headquarters
                  </p>
                </div>
              </div>
            </div>

            <div className="flex gap-2">
              <Button onClick={handleSave} disabled={isSaving || !tin || !bhfId}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save Credentials
              </Button>
            </div>
          </TabsContent>

          <TabsContent value="device" className="space-y-6 pt-4">
            {!isConfigured ? (
              <Alert>
                <AlertTriangle className="h-4 w-4" />
                <AlertDescription>
                  Please save your KRA PIN and Branch ID in the Credentials tab before initializing the device.
                </AlertDescription>
              </Alert>
            ) : (
              <>
                {/* Device Status */}
                <div className="space-y-4">
                  <h4 className="font-medium flex items-center gap-2">
                    <Server className="h-4 w-4" />
                    OSCU Device Status
                  </h4>

                  <div className="grid gap-4 sm:grid-cols-2">
                    <div className="p-4 rounded-lg border bg-muted/30">
                      <p className="text-sm text-muted-foreground">Device Serial</p>
                      <p className="font-mono font-medium">
                        {config?.device_serial || "Not initialized"}
                      </p>
                    </div>
                    <div className="p-4 rounded-lg border bg-muted/30">
                      <p className="text-sm text-muted-foreground">Communication Key</p>
                      <p className="font-medium">
                        {isInitialized ? (
                          <span className="text-green-600 flex items-center gap-1">
                            <CheckCircle2 className="h-4 w-4" /> Configured
                          </span>
                        ) : (
                          <span className="text-amber-600 flex items-center gap-1">
                            <AlertTriangle className="h-4 w-4" /> Not initialized
                          </span>
                        )}
                      </p>
                    </div>
                    <div className="p-4 rounded-lg border bg-muted/30">
                      <p className="text-sm text-muted-foreground">Sync Status</p>
                      <p className="font-medium capitalize">{config?.sync_status || "Pending"}</p>
                    </div>
                    <div className="p-4 rounded-lg border bg-muted/30">
                      <p className="text-sm text-muted-foreground">Last Sync</p>
                      <p className="font-medium">
                        {config?.last_sync_at 
                          ? format(new Date(config.last_sync_at), "PPp") 
                          : "Never"}
                      </p>
                    </div>
                  </div>
                </div>

                <Separator />

                {/* Device Actions */}
                <div className="space-y-4">
                  <h4 className="font-medium">Device Actions</h4>
                  <div className="flex flex-wrap gap-2">
                    <Button 
                      onClick={initializeDevice} 
                      disabled={Boolean(isInitializing) || Boolean(isInitialized)}
                      variant={isInitialized ? "outline" : "default"}
                    >
                      {isInitializing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <Server className="mr-2 h-4 w-4" />
                      )}
                      {isInitialized ? "Device Initialized" : "Initialize Device"}
                    </Button>

                    <Button 
                      onClick={handleSync} 
                      variant="outline" 
                      disabled={isSyncing || !isInitialized}
                    >
                      {isSyncing ? (
                        <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                      ) : (
                        <RefreshCw className="mr-2 h-4 w-4" />
                      )}
                      Sync Standard Codes
                    </Button>
                  </div>
                  
                  {!isInitialized && (
                    <p className="text-sm text-muted-foreground">
                      Click "Initialize Device" to register with KRA and receive your communication key automatically.
                    </p>
                  )}
                </div>

                <Separator />

                {/* Enable/Disable */}
                <div className="flex items-center justify-between p-4 rounded-lg border">
                  <div className="space-y-0.5">
                    <Label className="font-medium">Enable eTIMS Transmission</Label>
                    <p className="text-sm text-muted-foreground">
                      Automatically transmit invoices and credit notes to KRA
                    </p>
                  </div>
                  <Switch
                    checked={config?.is_active || false}
                    onCheckedChange={toggleActive}
                    disabled={!canActivate}
                  />
                </div>

                {!canActivate && (
                  <Alert variant="default">
                    <AlertTriangle className="h-4 w-4" />
                    <AlertDescription>
                      Complete device initialization to enable eTIMS transmission.
                    </AlertDescription>
                  </Alert>
                )}
              </>
            )}
          </TabsContent>

          <TabsContent value="logs" className="space-y-4 pt-4">
            <div className="flex items-center justify-between">
              <h4 className="font-medium flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Transmission Logs
              </h4>
              <Button variant="ghost" size="sm" onClick={refreshConfig}>
                <RefreshCw className="h-4 w-4" />
              </Button>
            </div>

            {isLoadingLogs ? (
              <div className="flex items-center justify-center py-8">
                <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
              </div>
            ) : logs.length === 0 ? (
              <div className="text-center py-8 text-muted-foreground">
                No transmission logs yet
              </div>
            ) : (
              <ScrollArea className="h-[400px]">
                <div className="space-y-2">
                  {logs.map((log) => (
                    <div 
                      key={log.id} 
                      className="p-3 rounded-lg border bg-muted/30 space-y-2"
                    >
                      <div className="flex items-center justify-between">
                        <div className="flex items-center gap-2">
                        <Badge variant={
                            log.status === "success" ? "default" as const :
                            log.status === "failed" ? "destructive" as const :
                            log.status === "retrying" ? "outline" as const :
                            "secondary" as const
                          }>
                            {log.status}
                          </Badge>
                          <span className="font-medium capitalize">{log.document_type}</span>
                          {log.document_number && (
                            <span className="text-sm text-muted-foreground">
                              #{log.document_number}
                            </span>
                          )}
                        </div>
                        <span className="text-xs text-muted-foreground flex items-center gap-1">
                          <Clock className="h-3 w-3" />
                          {format(new Date(log.transmitted_at), "PPp")}
                        </span>
                      </div>
                      {log.error_message && (
                        <p className="text-sm text-destructive">{log.error_message}</p>
                      )}
                      {log.response_code && (
                        <p className="text-xs text-muted-foreground">
                          Response: {log.response_code} - {log.response_message}
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              </ScrollArea>
            )}
          </TabsContent>
        </Tabs>
      </CardContent>
    </Card>
  );
}
