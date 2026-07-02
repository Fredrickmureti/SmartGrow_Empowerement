/**
 * POS Payment Terminals settings page.
 *
 * Tenant-owned credential surface — same UX shape as PaymentGatewaySettings
 * and SmsSettingsPage. Lists configured providers, lets owners/admins
 * add/edit/test/enable/disable/delete per Company.
 */

import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Card, CardContent, CardDescription, CardHeader, CardTitle,
} from "@/components/ui/card";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader,
  AlertDialogTitle, AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { CreditCard, Loader2, Plug, Trash2, ShieldCheck, ShieldAlert } from "lucide-react";
import {
  usePosTerminal,
  type TerminalProvider, type TerminalMode, type TerminalConfigMasked,
} from "@/hooks/pos/usePosTerminal";

const PROVIDERS: Array<{ id: TerminalProvider; label: string; help: string }> = [
  { id: "stripe_terminal", label: "Stripe Terminal", help: "BBPOS WisePOS E / S700, etc. Uses your Stripe restricted key." },
  { id: "adyen",           label: "Adyen",           help: "Adyen Cloud API. Needs merchant account + POI terminal id." },
  { id: "verifone",        label: "Verifone Cloud",  help: "P400, P630 over Verifone Cloud. Needs API key." },
  { id: "square_terminal", label: "Square Terminal", help: "Square Terminal API. Needs access token + device id." },
];

function ProviderForm({
  provider,
  existing,
  onCancel,
}: {
  provider: TerminalProvider;
  existing?: TerminalConfigMasked;
  onCancel: () => void;
}) {
  const { saveConfig, isSaving } = usePosTerminal();
  const [mode, setMode]   = useState<TerminalMode>(existing?.provider_mode ?? "test");
  const [name, setName]   = useState(existing?.display_name ?? "");
  const [apiKey, setKey]  = useState("");
  const [locId, setLoc]   = useState(existing?.location_id ?? "");
  const [merch, setMerch] = useState(existing?.merchant_account ?? "");
  const [poi, setPoi]     = useState(existing?.poi_terminal_id ?? "");
  const [enabled, setEnabled] = useState(existing?.is_enabled ?? true);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!apiKey || apiKey.length < 8) return;
    const id = await saveConfig({
      provider,
      provider_mode: mode,
      display_name: name || PROVIDERS.find(p => p.id === provider)!.label,
      api_key: apiKey,
      location_id: locId || null,
      merchant_account: merch || null,
      poi_terminal_id: poi || null,
      is_enabled: enabled,
    });
    if (id) { setKey(""); onCancel(); }
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="grid grid-cols-2 gap-4">
        <div className="space-y-1">
          <Label>Mode</Label>
          <Select value={mode} onValueChange={(v) => setMode(v as TerminalMode)}>
            <SelectTrigger><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="test">Sandbox (test)</SelectItem>
              <SelectItem value="live">Live</SelectItem>
            </SelectContent>
          </Select>
        </div>
        <div className="space-y-1">
          <Label>Display name</Label>
          <Input value={name} onChange={(e) => setName(e.target.value)} placeholder="Counter terminal" />
        </div>
      </div>

      <div className="space-y-1">
        <Label>API key / secret {existing?.has_secret && <span className="text-xs text-muted-foreground">(leave blank to keep current; enter to rotate)</span>}</Label>
        <Input
          type="password"
          value={apiKey}
          onChange={(e) => setKey(e.target.value)}
          required={!existing?.has_secret}
          minLength={8}
          placeholder={existing?.api_key_masked ?? "sk_test_…"}
          autoComplete="new-password"
        />
      </div>

      <div className="grid grid-cols-3 gap-4">
        <div className="space-y-1">
          <Label>Location id</Label>
          <Input value={locId} onChange={(e) => setLoc(e.target.value)} placeholder="tml_…" />
        </div>
        <div className="space-y-1">
          <Label>Merchant account</Label>
          <Input value={merch} onChange={(e) => setMerch(e.target.value)} />
        </div>
        <div className="space-y-1">
          <Label>POI / device id</Label>
          <Input value={poi} onChange={(e) => setPoi(e.target.value)} />
        </div>
      </div>

      <div className="flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Switch checked={enabled} onCheckedChange={setEnabled} id={`enable-${provider}`} />
          <Label htmlFor={`enable-${provider}`}>Enabled at checkout</Label>
        </div>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onCancel}>Cancel</Button>
          <Button type="submit" disabled={isSaving}>
            {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
            Save
          </Button>
        </div>
      </div>
    </form>
  );
}

function ProviderCard({ provider }: { provider: TerminalProvider }) {
  const { configs, testConnection, deleteConfig, isTesting } = usePosTerminal();
  const existing = useMemo(() => configs.find(c => c.provider === provider), [configs, provider]);
  const meta = PROVIDERS.find(p => p.id === provider)!;
  const [editing, setEditing] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between">
          <div>
            <CardTitle className="flex items-center gap-2">
              <CreditCard className="h-5 w-5" /> {meta.label}
              {existing?.is_enabled && <Badge variant="default">Enabled</Badge>}
              {existing && <Badge variant="outline">{existing.provider_mode.toUpperCase()}</Badge>}
            </CardTitle>
            <CardDescription>{meta.help}</CardDescription>
          </div>
          {existing && !editing && (
            <div className="flex gap-2">
              <Button
                variant="outline" size="sm"
                onClick={() => testConnection(existing.id)} disabled={isTesting}
              >
                {isTesting ? <Loader2 className="h-4 w-4 animate-spin" /> : <Plug className="h-4 w-4" />}
                <span className="ml-2">Test</span>
              </Button>
              <Button variant="outline" size="sm" onClick={() => setEditing(true)}>Edit</Button>
              <AlertDialog>
                <AlertDialogTrigger asChild>
                  <Button variant="ghost" size="sm"><Trash2 className="h-4 w-4" /></Button>
                </AlertDialogTrigger>
                <AlertDialogContent>
                  <AlertDialogHeader>
                    <AlertDialogTitle>Remove {meta.label} configuration?</AlertDialogTitle>
                    <AlertDialogDescription>
                      Stored credentials will be removed from the secure vault.
                      Cashiers will no longer be able to charge cards on this terminal.
                    </AlertDialogDescription>
                  </AlertDialogHeader>
                  <AlertDialogFooter>
                    <AlertDialogCancel>Cancel</AlertDialogCancel>
                    <AlertDialogAction onClick={() => deleteConfig(existing.id)}>
                      Remove
                    </AlertDialogAction>
                  </AlertDialogFooter>
                </AlertDialogContent>
              </AlertDialog>
            </div>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {existing && !editing && (
          <div className="grid grid-cols-2 gap-4 text-sm">
            <div><span className="text-muted-foreground">Secret:</span> {existing.api_key_masked ?? "—"}</div>
            <div><span className="text-muted-foreground">Location:</span> {existing.location_id ?? "—"}</div>
            <div><span className="text-muted-foreground">Merchant:</span> {existing.merchant_account ?? "—"}</div>
            <div><span className="text-muted-foreground">Device:</span> {existing.poi_terminal_id ?? "—"}</div>
            <div className="col-span-2 flex items-center gap-2">
              {existing.last_test_status === "ok"
                ? <ShieldCheck className="h-4 w-4 text-green-600" />
                : <ShieldAlert className="h-4 w-4 text-yellow-600" />}
              <span className="text-muted-foreground">
                Last test: {existing.last_test_at
                  ? `${new Date(existing.last_test_at).toLocaleString()} — ${existing.last_test_status}`
                  : "never"}
                {existing.last_test_error ? ` (${existing.last_test_error})` : ""}
              </span>
            </div>
          </div>
        )}
        {(editing || !existing) && (
          <ProviderForm
            provider={provider}
            existing={existing}
            onCancel={() => setEditing(false)}
          />
        )}
      </CardContent>
    </Card>
  );
}

export default function PosTerminalsPage() {
  const { isLoading } = usePosTerminal();
  return (
    <div className="space-y-6 max-w-4xl mx-auto p-6">
      <header>
        <h1 className="text-2xl font-semibold">Payment terminals</h1>
        <p className="text-muted-foreground text-sm">
          Plug in your own card-terminal credentials per Company. Start in sandbox, test, then flip to live.
          Credentials are stored in Supabase Vault and never leave the server.
        </p>
      </header>
      {isLoading && <div className="flex items-center gap-2 text-sm text-muted-foreground"><Loader2 className="h-4 w-4 animate-spin" /> Loading…</div>}
      {PROVIDERS.map(p => <ProviderCard key={p.id} provider={p.id} />)}
    </div>
  );
}
