import { useState, useEffect } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Slider } from "@/components/ui/slider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { 
  Bug, 
  Eye, 
  EyeOff, 
  Check, 
  X, 
  Loader2,
  ExternalLink,
  AlertCircle,
  Zap
} from "lucide-react";
import { usePlatformSettings } from "@/hooks/usePlatformSettings";
import { reinitializeSentry, disableSentry, testSentryConnection } from "@/lib/sentry";
import { useToast } from "@/hooks/use-toast";

export function SentrySettings() {
  const { settings, isLoading, isSaving, getSetting, updateMultipleSettings } = usePlatformSettings();
  const { toast } = useToast();
  
  const [showDsn, setShowDsn] = useState(false);
  const [isTesting, setIsTesting] = useState(false);
  
  // Form states
  const [enabled, setEnabled] = useState(false);
  const [dsn, setDsn] = useState("");
  const [environment, setEnvironment] = useState("auto");
  const [sampleRate, setSampleRate] = useState(10);

  // Load settings when available
  useEffect(() => {
    if (settings.length > 0) {
      setEnabled(getSetting("sentry_enabled") === "true");
      setDsn(getSetting("sentry_dsn") || "");
      setEnvironment(getSetting("sentry_environment") || "auto");
      const rate = parseFloat(getSetting("sentry_sample_rate") || "0.1");
      setSampleRate(Math.round(rate * 100));
    }
  }, [settings]);

  const handleSave = async () => {
    await updateMultipleSettings([
      { key: "sentry_enabled", value: enabled ? "true" : "false" },
      { key: "sentry_dsn", value: dsn || null },
      { key: "sentry_environment", value: environment },
      { key: "sentry_sample_rate", value: (sampleRate / 100).toString() },
    ]);

    // Apply configuration immediately
    if (enabled && dsn) {
      reinitializeSentry({
        dsn,
        environment: environment === "auto" ? undefined : environment,
        sampleRate: sampleRate / 100,
      });
      toast({
        title: "Error tracking activated",
        description: "Sentry is now capturing errors in real-time.",
      });
    } else {
      disableSentry();
      toast({
        title: "Error tracking disabled",
        description: "Sentry has been deactivated.",
      });
    }
  };

  const handleTestConnection = async () => {
    if (!dsn) {
      toast({
        title: "DSN Required",
        description: "Please enter a Sentry DSN before testing.",
        variant: "destructive",
      });
      return;
    }

    setIsTesting(true);
    try {
      const result = await testSentryConnection(dsn);
      if (result.success) {
        toast({
          title: "Connection successful",
          description: "Sentry DSN is valid and ready to use.",
        });
      } else {
        toast({
          title: "Connection failed",
          description: result.error || "Invalid DSN format or network error.",
          variant: "destructive",
        });
      }
    } catch (error) {
      toast({
        title: "Connection failed",
        description: "Could not validate the Sentry DSN.",
        variant: "destructive",
      });
    } finally {
      setIsTesting(false);
    }
  };

  const isConfigured = Boolean(getSetting("sentry_dsn"));
  const isActive = getSetting("sentry_enabled") === "true" && isConfigured;

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          <Bug className="h-5 w-5" />
          Error Tracking (Sentry)
          {isActive ? (
            <Badge variant="default" className="ml-2">
              <Check className="h-3 w-3 mr-1" />
              Active
            </Badge>
          ) : isConfigured ? (
            <Badge variant="secondary" className="ml-2">
              <X className="h-3 w-3 mr-1" />
              Disabled
            </Badge>
          ) : (
            <Badge variant="outline" className="ml-2">
              Not Configured
            </Badge>
          )}
        </CardTitle>
        <CardDescription>
          Capture and monitor application errors in real-time with Sentry
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <Alert>
          <AlertCircle className="h-4 w-4" />
          <AlertDescription>
            The Sentry DSN is a public key and safe to store. Error tracking activates immediately when saved.
          </AlertDescription>
        </Alert>

        {/* Enable Toggle */}
        <div className="flex items-center justify-between py-2">
          <div className="space-y-0.5">
            <Label htmlFor="sentry-enabled">Enable Error Tracking</Label>
            <p className="text-sm text-muted-foreground">
              Capture JavaScript errors and unhandled exceptions
            </p>
          </div>
          <Switch
            id="sentry-enabled"
            checked={enabled}
            onCheckedChange={setEnabled}
          />
        </div>

        {/* DSN Input */}
        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="sentry-dsn">Sentry DSN</Label>
            <a
              href="https://sentry.io/settings/projects/"
              target="_blank"
              rel="noopener noreferrer"
              className="text-sm text-primary hover:underline flex items-center gap-1"
            >
              Get DSN <ExternalLink className="h-3 w-3" />
            </a>
          </div>
          <div className="relative">
            <Input
              id="sentry-dsn"
              type={showDsn ? "text" : "password"}
              value={dsn}
              onChange={(e) => setDsn(e.target.value)}
              placeholder="https://abc123...@o12345.ingest.us.sentry.io/67890"
              className="pr-10 font-mono text-sm"
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="absolute right-0 top-0 h-full px-3"
              onClick={() => setShowDsn(!showDsn)}
            >
              {showDsn ? (
                <EyeOff className="h-4 w-4" />
              ) : (
                <Eye className="h-4 w-4" />
              )}
            </Button>
          </div>
          <p className="text-xs text-muted-foreground">
            Find your DSN in Sentry: Project Settings → Client Keys (DSN). 
            Format: https://[key]@[host]/[project_id]
          </p>
        </div>

        {/* Environment Selection */}
        <div className="space-y-2">
          <Label htmlFor="sentry-environment">Environment</Label>
          <Select value={environment} onValueChange={setEnvironment}>
            <SelectTrigger id="sentry-environment">
              <SelectValue placeholder="Select environment" />
            </SelectTrigger>
            <SelectContent>
              <SelectItem value="auto">Auto-detect</SelectItem>
              <SelectItem value="production">Production</SelectItem>
              <SelectItem value="preview">Preview</SelectItem>
              <SelectItem value="development">Development</SelectItem>
            </SelectContent>
          </Select>
          <p className="text-xs text-muted-foreground">
            Auto-detect uses the current hostname to determine environment
          </p>
        </div>

        {/* Sample Rate Slider */}
        <div className="space-y-4">
          <div className="flex items-center justify-between">
            <Label>Trace Sample Rate</Label>
            <span className="text-sm font-medium">{sampleRate}%</span>
          </div>
          <Slider
            value={[sampleRate]}
            onValueChange={(value) => setSampleRate(value[0])}
            min={1}
            max={100}
            step={1}
            className="w-full"
          />
          <p className="text-xs text-muted-foreground">
            Percentage of transactions to trace for performance monitoring. Lower values reduce costs.
          </p>
        </div>

        {/* Action Buttons */}
        <div className="flex items-center gap-3 pt-2">
          <Button
            variant="outline"
            onClick={handleTestConnection}
            disabled={isTesting || !dsn}
          >
            {isTesting ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Zap className="h-4 w-4 mr-2" />
            )}
            Test Connection
          </Button>
          <Button onClick={handleSave} disabled={isSaving}>
            {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
            Save & {enabled ? "Activate" : "Deactivate"}
          </Button>
        </div>

        {/* Current Status */}
        {isConfigured && (
          <div className="pt-4 border-t">
            <div className="flex items-center justify-between text-sm">
              <span className="text-muted-foreground">Status:</span>
              <Badge variant={isActive ? "default" : "secondary"}>
                {isActive ? "Capturing Errors" : "Inactive"}
              </Badge>
            </div>
          </div>
        )}
      </CardContent>
    </Card>
  );
}
