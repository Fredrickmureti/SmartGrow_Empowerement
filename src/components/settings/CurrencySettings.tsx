import { useState, useEffect, useCallback } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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
import { useToast } from "@/hooks/use-toast";
import { Loader2, Plus, Trash2 } from "lucide-react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { normalizeError } from "@/services/resilience";

interface Currency {
  id: string;
  code: string;
  name: string;
  symbol: string;
  decimal_places: number;
  is_active: boolean;
}

/** A row of the one rate book (`public.exchange_rates`), with its provenance. */
interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  effective_date: string;
  source: string;
  provider_key: string | null;
  published_at: string | null;
}

interface ActiveCurrency {
  currency_code: string;
  is_enabled: boolean;
}

const SOURCE_LABEL: Record<string, string> = {
  override: "Override",
  manual: "Manual",
  provider: "Platform",
};

function sourceVariant(source: string): "default" | "secondary" | "outline" {
  if (source === "override") return "default";
  if (source === "manual") return "secondary";
  return "outline";
}

export function CurrencySettings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness, refreshBusinesses } = useBusinesses();
  const { canManageCurrency } = usePermissions();
  const { toast } = useToast();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [activeCurrencies, setActiveCurrencies] = useState<ActiveCurrency[]>([]);
  const [baseCurrency, setBaseCurrency] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showRateDialog, setShowRateDialog] = useState(false);
  const [rateForm, setRateForm] = useState({
    from_currency: "",
    rate: 1,
    effective_date: new Date().toISOString().split("T")[0],
    reason: "",
  });

  const canEdit = canManageCurrency;
  const base = (currentBusiness?.base_currency ?? "").toUpperCase();

  const fetchCurrencies = useCallback(async () => {
    const { data, error } = await supabase
      .from("currencies")
      .select("*")
      .eq("is_active", true)
      .order("code");
    if (error) {
      console.error("Error fetching currencies:", error);
      return;
    }
    setCurrencies(data ?? []);
  }, []);

  const fetchExchangeRates = useCallback(async () => {
    if (!currentOrg || !currentBusiness) return;
    // FX rates are per-company: exchange_rates.business_id is NOT NULL.
    const { data, error } = await supabase
      .from("exchange_rates")
      .select(
        "id, from_currency, to_currency, rate, effective_date, source, provider_key, published_at",
      )
      .eq("organization_id", currentOrg.id)
      .eq("business_id", currentBusiness.id)
      .order("effective_date", { ascending: false })
      .order("published_at", { ascending: false });
    if (error) {
      console.error("Error fetching exchange rates:", error);
      return;
    }
    setExchangeRates((data ?? []) as ExchangeRate[]);
  }, [currentOrg, currentBusiness]);

  const fetchActiveCurrencies = useCallback(async () => {
    if (!currentBusiness) return;
    const { data, error } = await supabase
      .from("business_active_currencies")
      .select("currency_code, is_enabled")
      .eq("business_id", currentBusiness.id);
    if (error) {
      console.error("Error fetching active currencies:", error);
      return;
    }
    setActiveCurrencies((data ?? []) as ActiveCurrency[]);
  }, [currentBusiness]);

  useEffect(() => {
    setIsLoading(true);
    void Promise.all([
      fetchCurrencies(),
      fetchExchangeRates(),
      fetchActiveCurrencies(),
    ]).finally(() => setIsLoading(false));
    setBaseCurrency(currentBusiness?.base_currency ?? "");
  }, [fetchCurrencies, fetchExchangeRates, fetchActiveCurrencies, currentBusiness]);

  const handleSaveBaseCurrency = async () => {
    if (!currentBusiness || !canEdit) return;
    setIsSaving(true);
    try {
      // base_currency lives on businesses; trg_business_currency_lock rejects
      // a change once the first journal entry exists.
      const { error } = await supabase
        .from("businesses")
        .update({ base_currency: baseCurrency })
        .eq("id", currentBusiness.id);
      if (error) throw error;
      toast({ title: "Base currency updated" });
      await refreshBusinesses();
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleToggleCurrency = async (code: string, enabled: boolean) => {
    if (!currentBusiness || !canEdit) return;
    try {
      const { error } = await supabase.rpc("set_business_active_currency", {
        p_business_id: currentBusiness.id,
        p_currency: code,
        p_enabled: enabled,
      });
      if (error) throw error;
      await fetchActiveCurrencies();
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  const handleAddOverride = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentBusiness) return;
    setIsSaving(true);
    try {
      // Server-validated: writes source = 'override' and an audit row. It never
      // mutates the published provider rate (ADR 0136).
      const { error } = await supabase.rpc("set_exchange_rate_override", {
        p_business_id: currentBusiness.id,
        p_from_currency: rateForm.from_currency,
        p_to_currency: base,
        p_rate: rateForm.rate,
        p_effective_date: rateForm.effective_date,
        p_reason: rateForm.reason,
      });
      if (error) throw error;
      toast({ title: "Override recorded" });
      setShowRateDialog(false);
      setRateForm({
        from_currency: "",
        rate: 1,
        effective_date: new Date().toISOString().split("T")[0],
        reason: "",
      });
      await fetchExchangeRates();
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteRate = async (rate: ExchangeRate) => {
    if (rate.source === "provider") return;
    if (!confirm("Remove this rate? Documents already posted keep the rate they were stamped with."))
      return;
    if (!currentOrg?.id || !currentBusiness?.id) {
      toast({ title: "Select a company first", variant: "destructive" });
      return;
    }
    try {
      const { error } = await supabase
        .from("exchange_rates")
        .delete()
        .eq("id", rate.id)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);
      if (error) throw error;
      toast({ title: "Rate removed" });
      await fetchExchangeRates();
    } catch (error: unknown) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    }
  };

  if (isLoading) {
    return (
      <div className="flex items-center justify-center py-8">
        <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  const enabledSet = new Set(
    activeCurrencies.filter((c) => c.is_enabled).map((c) => c.currency_code),
  );

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Base Currency</CardTitle>
          <CardDescription>
            The currency this company keeps its books in. It is locked once the first
            journal entry is posted.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 items-end max-w-md">
            <div className="flex-1 space-y-2">
              <Label>Base currency</Label>
              <Select value={baseCurrency} onValueChange={setBaseCurrency} disabled={!canEdit}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {currencies.map((c) => (
                    <SelectItem key={c.id} value={c.code}>
                      {c.code} - {c.name} ({c.symbol})
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            {canEdit && (
              <Button onClick={handleSaveBaseCurrency} disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Save
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle>Operating Currencies</CardTitle>
          <CardDescription>
            Currencies this company is allowed to transact in. The base currency is always
            enabled. Leave everything off to allow any currency that has a rate on file.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <div className="flex flex-wrap gap-3">
            {currencies.map((c) => {
              const isBase = c.code === base;
              return (
                <label
                  key={c.id}
                  className="flex items-center gap-2 rounded-md border px-3 py-2 text-sm"
                >
                  <Switch
                    checked={isBase || enabledSet.has(c.code)}
                    disabled={!canEdit || isBase}
                    onCheckedChange={(v) => handleToggleCurrency(c.code, v)}
                  />
                  <span className="font-medium">{c.code}</span>
                  {isBase && <Badge variant="outline">Base</Badge>}
                </label>
              );
            })}
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle>Rate Book</CardTitle>
            <CardDescription>
              Every rate the company can use, and where it came from. Overrides win over
              manual rates, which win over platform rates; the most recent effective date
              wins. Documents keep the rate they were stamped with.
            </CardDescription>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setShowRateDialog(true)} disabled={!base}>
              <Plus className="mr-2 h-4 w-4" />
              Add override
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {exchangeRates.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">
              No rates on file. Foreign-currency documents will be refused until a rate
              exists — they are never posted at 1:1.
            </p>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Pair</TableHead>
                    <TableHead>Rate</TableHead>
                    <TableHead>Source</TableHead>
                    <TableHead className="hidden md:table-cell">Provider</TableHead>
                    <TableHead className="hidden sm:table-cell">Effective</TableHead>
                    <TableHead className="hidden lg:table-cell">Published</TableHead>
                    {canEdit && <TableHead className="w-12" />}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exchangeRates.map((rate) => (
                    <TableRow key={rate.id}>
                      <TableCell className="font-medium">
                        {rate.from_currency}/{rate.to_currency}
                      </TableCell>
                      <TableCell>{Number(rate.rate)}</TableCell>
                      <TableCell>
                        <Badge variant={sourceVariant(rate.source)}>
                          {SOURCE_LABEL[rate.source] ?? rate.source}
                        </Badge>
                      </TableCell>
                      <TableCell className="hidden md:table-cell text-muted-foreground">
                        {rate.provider_key ?? "—"}
                      </TableCell>
                      <TableCell className="hidden sm:table-cell">
                        {rate.effective_date}
                      </TableCell>
                      <TableCell className="hidden lg:table-cell text-muted-foreground">
                        {rate.published_at
                          ? new Date(rate.published_at).toLocaleString()
                          : "—"}
                      </TableCell>
                      {canEdit && (
                        <TableCell>
                          {rate.source !== "provider" && (
                            <Button
                              variant="ghost"
                              size="icon"
                              onClick={() => handleDeleteRate(rate)}
                            >
                              <Trash2 className="h-4 w-4 text-destructive" />
                            </Button>
                          )}
                        </TableCell>
                      )}
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          )}
        </CardContent>
      </Card>

      <Dialog open={showRateDialog} onOpenChange={setShowRateDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add rate override</DialogTitle>
            <DialogDescription>
              Recorded against your company only, with your name and reason. The platform
              rate is left untouched.
            </DialogDescription>
          </DialogHeader>
          <form onSubmit={handleAddOverride} className="space-y-4">
            <div className="grid gap-4 grid-cols-2">
              <div className="space-y-2">
                <Label>From currency</Label>
                <Select
                  value={rateForm.from_currency}
                  onValueChange={(v) => setRateForm({ ...rateForm, from_currency: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies
                      .filter((c) => c.code !== base)
                      .map((c) => (
                        <SelectItem key={c.id} value={c.code}>
                          {c.code}
                        </SelectItem>
                      ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>To currency</Label>
                <Input value={base} disabled />
              </div>
            </div>
            <div className="space-y-2">
              <Label>Rate</Label>
              <Input
                type="number"
                step="0.000001"
                min="0"
                value={rateForm.rate}
                onChange={(e) =>
                  setRateForm({ ...rateForm, rate: parseFloat(e.target.value) || 0 })
                }
                required
              />
              <p className="text-sm text-muted-foreground">
                1 {rateForm.from_currency || "FROM"} = {rateForm.rate} {base || "BASE"}
              </p>
            </div>
            <div className="space-y-2">
              <Label>Effective date</Label>
              <Input
                type="date"
                value={rateForm.effective_date}
                onChange={(e) => setRateForm({ ...rateForm, effective_date: e.target.value })}
                required
              />
            </div>
            <div className="space-y-2">
              <Label>Reason</Label>
              <Input
                value={rateForm.reason}
                onChange={(e) => setRateForm({ ...rateForm, reason: e.target.value })}
                placeholder="e.g. contractual rate agreed with the supplier"
                required
              />
            </div>
            <Button type="submit" className="w-full" disabled={isSaving || !rateForm.from_currency}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Save override
            </Button>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
