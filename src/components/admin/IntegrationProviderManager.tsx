/**
 * IntegrationProviderManager — reusable UI for the generic
 * platform_integration_* framework. Mount with a capabilityKey and it
 * renders provider list, credential form, test/run buttons, auto-refresh
 * toggle, and recent-run audit table.
 *
 * Same component will manage exchange_rates today and sms / email /
 * payments tomorrow without writing new UI.
 */
import { useEffect, useMemo, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Separator } from "@/components/ui/separator";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  AlertCircle,
  CheckCircle2,
  ExternalLink,
  Loader2,
  Play,
  Plug,
  RefreshCw,
  TestTube2,
  Trash2,
} from "lucide-react";
import { format, formatDistanceToNow } from "date-fns";
import {
  useIntegrationProviders,
  type CredentialField,
  type IntegrationProvider,
} from "@/hooks/useIntegrationProviders";

interface Props {
  capabilityKey: string;
  title?: string;
  description?: string;
}

export function IntegrationProviderManager({
  capabilityKey,
  title = "Integration providers",
  description = "Connect, test and schedule external service providers.",
}: Props) {
  const {
    providers,
    connections,
    activeConnection,
    runs,
    isLoading,
    saveConnection,
    isSaving,
    deleteConnection,
    testConnection,
    isTesting,
    runConnection,
    isRunning,
  } = useIntegrationProviders(capabilityKey);

  const [selectedProviderId, setSelectedProviderId] = useState<string>("");
  const [creds, setCreds] = useState<Record<string, string>>({});
  const [autoRefresh, setAutoRefresh] = useState(false);
  const [intervalHours, setIntervalHours] = useState(24);
  const [editingId, setEditingId] = useState<string | null>(null);

  // When an active connection exists, pre-load it into the form on mount.
  useEffect(() => {
    if (!activeConnection) return;
    setSelectedProviderId(activeConnection.provider_id);
    setCreds({}); // secrets are never sent to the browser; blank = keep stored value
    setAutoRefresh(activeConnection.auto_refresh_enabled);
    setIntervalHours(activeConnection.auto_refresh_interval_hours);
    setEditingId(activeConnection.id);
  }, [activeConnection]);

  const selectedProvider: IntegrationProvider | undefined = useMemo(
    () => providers.find((p) => p.id === selectedProviderId),
    [providers, selectedProviderId],
  );

  const editingConnection = useMemo(
    () => connections.find((c) => c.id === editingId) ?? null,
    [connections, editingId],
  );

  const storedKeys = editingConnection?.credential_keys ?? [];

  const credentialFields = useMemo<[string, CredentialField][]>(
    () => Object.entries(selectedProvider?.credential_schema ?? {}),
    [selectedProvider],
  );

  const handleProviderChange = (id: string) => {
    setSelectedProviderId(id);
    // If switching providers, reset credentials & editingId
    const existing = connections.find((c) => c.provider_id === id);
    if (existing) {
      setEditingId(existing.id);
      setCreds({});
      setAutoRefresh(existing.auto_refresh_enabled);
      setIntervalHours(existing.auto_refresh_interval_hours);
    } else {
      setEditingId(null);
      setCreds({});
      setAutoRefresh(false);
      setIntervalHours(24);
    }
  };

  const handleSaveAndActivate = () => {
    if (!selectedProviderId) return;
    saveConnection({
      id: editingId ?? undefined,
      provider_id: selectedProviderId,
      credentials: creds,
      auto_refresh_enabled: autoRefresh,
      auto_refresh_interval_hours: intervalHours,
      activate: true,
    });
  };

  const renderStatusBadge = (status: string | null) => {
    if (!status) return <Badge variant="outline">never run</Badge>;
    const variant =
      status === "success"
        ? "default"
        : status === "partial"
        ? "secondary"
        : status === "failed"
        ? "destructive"
        : "outline";
    return <Badge variant={variant as any}>{status}</Badge>;
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-base">
            <Plug className="h-5 w-5" />
            {title}
          </CardTitle>
          <CardDescription>{description}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-5">
          {isLoading ? (
            <div className="flex items-center justify-center py-8">
              <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
            </div>
          ) : providers.length === 0 ? (
            <div className="text-sm text-muted-foreground py-6 text-center">
              No providers registered for capability <code>{capabilityKey}</code>.
            </div>
          ) : (
            <>
              {/* Active summary */}
              {activeConnection && (
                <div className="flex items-center gap-3 rounded-md border bg-muted/40 px-3 py-2">
                  {activeConnection.last_test_ok === false ? (
                    <AlertCircle className="h-4 w-4 text-destructive" />
                  ) : (
                    <CheckCircle2 className="h-4 w-4 text-primary" />
                  )}
                  <div className="text-sm flex-1 min-w-0">
                    <div className="font-medium">
                      Active:{" "}
                      {providers.find((p) => p.id === activeConnection.provider_id)
                        ?.display_name ?? "Unknown"}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {activeConnection.last_run_at
                        ? `Last run ${formatDistanceToNow(
                            new Date(activeConnection.last_run_at),
                            { addSuffix: true },
                          )} — ${activeConnection.last_run_message ?? activeConnection.last_run_status}`
                        : "Has not been run yet."}
                    </div>
                    {activeConnection.auto_refresh_enabled && activeConnection.next_run_at && (
                      <div className="text-xs text-muted-foreground mt-0.5">
                        Next scheduled run{" "}
                        {formatDistanceToNow(new Date(activeConnection.next_run_at), {
                          addSuffix: true,
                        })}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {/* Provider picker */}
              <div className="space-y-2">
                <Label>Provider</Label>
                <Select value={selectedProviderId} onValueChange={handleProviderChange}>
                  <SelectTrigger>
                    <SelectValue placeholder="Pick a provider…" />
                  </SelectTrigger>
                  <SelectContent>
                    {providers.map((p) => (
                      <SelectItem key={p.id} value={p.id}>
                        {p.display_name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedProvider?.description && (
                  <p className="text-xs text-muted-foreground">
                    {selectedProvider.description}
                    {selectedProvider.docs_url && (
                      <a
                        href={selectedProvider.docs_url}
                        target="_blank"
                        rel="noreferrer"
                        className="ml-2 inline-flex items-center gap-1 text-primary hover:underline"
                      >
                        Docs <ExternalLink className="h-3 w-3" />
                      </a>
                    )}
                  </p>
                )}
              </div>

              {/* Credential fields */}
              {selectedProvider && (
                <div className="space-y-3">
                  {credentialFields.length === 0 && (
                    <p className="text-xs text-muted-foreground">
                      No credentials required.
                    </p>
                  )}
                  {credentialFields.map(([key, field]) => (
                    <div key={key} className="space-y-1.5">
                      <Label htmlFor={`cred-${key}`}>
                        {field.label}
                        {field.required && <span className="text-destructive ml-1">*</span>}
                      </Label>
                      <Input
                        id={`cred-${key}`}
                        type={field.secret ? "password" : "text"}
                        value={creds[key] ?? ""}
                        onChange={(e) => setCreds({ ...creds, [key]: e.target.value })}
                        placeholder={
                          storedKeys.includes(key)
                            ? "Stored — leave blank to keep"
                            : field.secret
                            ? "••••••••"
                            : ""
                        }
                        autoComplete="off"
                      />
                      {storedKeys.includes(key) && (
                        <p className="text-xs text-muted-foreground">
                          A value is on file
                          {editingConnection?.credentials_set_at
                            ? ` (updated ${formatDistanceToNow(
                                new Date(editingConnection.credentials_set_at),
                                { addSuffix: true },
                              )})`
                            : ""}
                          . Secrets are stored server-side and are never sent back to this screen.
                        </p>
                      )}
                    </div>
                  ))}
                </div>
              )}

              {/* Auto-refresh */}
              {selectedProvider && (
                <div className="rounded-md border p-3 space-y-3">
                  <div className="flex items-center justify-between gap-3">
                    <div>
                      <div className="text-sm font-medium">Periodic auto-refresh</div>
                      <div className="text-xs text-muted-foreground">
                        Off by default to avoid API costs. Manual refresh always available.
                      </div>
                    </div>
                    <Switch checked={autoRefresh} onCheckedChange={setAutoRefresh} />
                  </div>
                  {autoRefresh && (
                    <div className="flex items-center gap-2 text-sm">
                      <span className="text-muted-foreground">Run every</span>
                      <Input
                        type="number"
                        min={1}
                        max={720}
                        value={intervalHours}
                        onChange={(e) => setIntervalHours(parseInt(e.target.value || "24"))}
                        className="w-24 h-8"
                      />
                      <span className="text-muted-foreground">hours</span>
                    </div>
                  )}
                </div>
              )}

              {/* Action row */}
              {selectedProvider && (
                <div className="flex flex-wrap items-center gap-2">
                  <Button onClick={handleSaveAndActivate} disabled={isSaving}>
                    {isSaving && <Loader2 className="h-4 w-4 mr-2 animate-spin" />}
                    Save & activate
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!editingId || isTesting}
                    onClick={() => editingId && testConnection(editingId)}
                  >
                    {isTesting ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <TestTube2 className="h-4 w-4 mr-2" />
                    )}
                    Test
                  </Button>
                  <Button
                    variant="outline"
                    disabled={!editingId || !activeConnection || isRunning}
                    onClick={() => editingId && runConnection(editingId)}
                  >
                    {isRunning ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Play className="h-4 w-4 mr-2" />
                    )}
                    Fetch now
                  </Button>
                  {editingId && (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto text-destructive"
                      onClick={() => {
                        if (confirm("Remove this connection?")) deleteConnection(editingId);
                      }}
                    >
                      <Trash2 className="h-4 w-4 mr-1.5" />
                      Remove
                    </Button>
                  )}
                </div>
              )}
            </>
          )}
        </CardContent>
      </Card>

      {/* Recent runs */}
      {runs.length > 0 && (
        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <RefreshCw className="h-4 w-4" />
              Recent runs
            </CardTitle>
          </CardHeader>
          <CardContent>
            <Table>
              <TableHeader>
                <TableRow>
                  <TableHead>When</TableHead>
                  <TableHead>Trigger</TableHead>
                  <TableHead>Status</TableHead>
                  <TableHead>Message</TableHead>
                </TableRow>
              </TableHeader>
              <TableBody>
                {runs.slice(0, 10).map((r) => (
                  <TableRow key={r.id}>
                    <TableCell className="text-xs">
                      {format(new Date(r.started_at), "MMM d, HH:mm:ss")}
                    </TableCell>
                    <TableCell className="text-xs capitalize">{r.trigger_kind}</TableCell>
                    <TableCell>{renderStatusBadge(r.status)}</TableCell>
                    <TableCell className="text-xs text-muted-foreground max-w-[300px] truncate">
                      {r.message ?? "—"}
                    </TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
