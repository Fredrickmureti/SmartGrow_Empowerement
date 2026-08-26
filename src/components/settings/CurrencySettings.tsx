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
import {
  AlertTriangle,
  CheckCircle2,
  LockKeyhole,
  Loader2,
  Plus,
  Search,
  ChevronDown,
  ChevronUp,
} from "lucide-react";
import { ScrollArea } from "@/components/ui/scroll-area";

import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
} from "@/components/ui/dialog";
import { normalizeError } from "@/services/resilience";
import { useFxRateCoverage } from "@/hooks/useFxRateCoverage";
import { FxRateCoverageCard } from "@/components/settings/FxRateCoverageCard";

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
  is_base: boolean;
}

interface CurrencyReadiness {
  state: "ready" | "confirmation_required" | "locked";
  can_change: boolean;
  requires_confirmation: boolean;
  journal_entry_count: number;
  draft_total: number;
  draft_counts: Record<string, number>;
  foreign_bank_account_count: number;
  non_base_operating_currency_count: number;
  reconciliation_count: number;
  closed_period_count: number;
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
  const [readiness, setReadiness] = useState<CurrencyReadiness | null>(null);
  const [showBaseCurrencyDialog, setShowBaseCurrencyDialog] = useState(false);
  const [changeReason, setChangeReason] = useState("");
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
  const {
    summary: coverage,
    isLoading: coverageLoading,
    error: coverageError,
    refresh: refreshCoverage,
  } = useFxRateCoverage(currentBusiness?.id ?? null);

  /** Open the override dialog aimed at a specific coverage gap. */
  const openRateForGap = (currency: string, effectiveDate?: string) => {
    setRateForm({
      from_currency: currency,
      rate: 0,
      effective_date: effectiveDate ?? new Date().toISOString().split("T")[0],
      reason: "",
    });
    setShowRateDialog(true);
  };
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
    // Server-resolved: the base currency is flagged there, never inferred here.
    const { data, error } = await supabase.rpc("list_business_active_currencies", {
      _business_id: currentBusiness.id,
    });
    if (error) {
      console.error("Error fetching active currencies:", error);
      return;
    }
    setActiveCurrencies((data ?? []) as ActiveCurrency[]);
  }, [currentBusiness]);

  const fetchReadiness = useCallback(async () => {
    if (!currentBusiness) return;
    const { data, error } = await supabase.rpc("business_currency_readiness", {
      p_business_id: currentBusiness.id,
    });
    if (error) {
      console.error("Error fetching base-currency readiness:", error);
      return;
    }
    setReadiness(data as unknown as CurrencyReadiness);
  }, [currentBusiness]);


  useEffect(() => {
    setIsLoading(true);
    void Promise.all([
      fetchCurrencies(),
      fetchExchangeRates(),
      fetchActiveCurrencies(),
      fetchReadiness(),
    ]).finally(() => setIsLoading(false));
    setBaseCurrency(currentBusiness?.base_currency ?? "");
  }, [fetchCurrencies, fetchExchangeRates, fetchActiveCurrencies, fetchReadiness, currentBusiness]);

  const handleSaveBaseCurrency = async () => {
    if (!currentBusiness || !canEdit) return;
    setIsSaving(true);
    try {
      const { error } = await supabase.rpc("change_business_base_currency", {
        p_business_id: currentBusiness.id,
        p_new_currency: baseCurrency,
        p_reason: changeReason,
        p_confirm_impacts: readiness?.requires_confirmation ?? false,
      });
      if (error) throw error;
      toast({ title: `Base currency changed to ${baseCurrency}` });
      setShowBaseCurrencyDialog(false);
      setChangeReason("");
      await Promise.all([refreshBusinesses(), fetchReadiness(), fetchActiveCurrencies()]);
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

  const openBaseCurrencyChange = () => {
    if (!readiness?.can_change || baseCurrency === base) return;
    setShowBaseCurrencyDialog(true);
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
      await Promise.all([fetchExchangeRates(), refreshCoverage()]);
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

  // No delete path: the rate book is append-only evidence. A wrong rate is
  // corrected by recording a new dated override, which outranks the old row
  // while leaving the basis of already-posted documents explainable.

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
  const serverBaseSet = new Set(
    activeCurrencies.filter((c) => c.is_base).map((c) => c.currency_code),
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
        <CardContent className="space-y-5">
          <div className="flex items-start gap-3 rounded-md border p-4">
            {readiness?.state === "locked" ? (
              <LockKeyhole className="mt-0.5 h-5 w-5 shrink-0 text-destructive" />
            ) : readiness?.state === "confirmation_required" ? (
              <AlertTriangle className="mt-0.5 h-5 w-5 shrink-0 text-amber-600" />
            ) : (
              <CheckCircle2 className="mt-0.5 h-5 w-5 shrink-0 text-emerald-600" />
            )}
            <div className="space-y-1">
              <p className="font-medium">
                {readiness?.state === "locked"
                  ? "Base currency is permanently locked"
                  : readiness?.state === "confirmation_required"
                    ? "Changes require an impact review"
                    : "Base currency can be changed"}
              </p>
              <p className="text-sm text-muted-foreground">
                {readiness?.state === "locked"
                  ? `${readiness.journal_entry_count} accounting ${readiness.journal_entry_count === 1 ? "entry exists" : "entries exist"}; historical books will not be converted.`
                  : readiness?.state === "confirmation_required"
                    ? "Draft rates and related currency settings will be reviewed before the change is applied."
                    : "No accounting history or dependent currency setup blocks a change."}
              </p>
            </div>
          </div>
          <div className="flex gap-4 items-end max-w-md">
            <div className="flex-1 space-y-2">
              <Label>Base currency</Label>
              <Select value={baseCurrency} onValueChange={setBaseCurrency} disabled={!canEdit || !readiness?.can_change}>
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
              <Button onClick={openBaseCurrencyChange} disabled={isSaving || !readiness?.can_change || baseCurrency === base}>
                Review change
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      <Dialog open={showBaseCurrencyDialog} onOpenChange={setShowBaseCurrencyDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Change base currency to {baseCurrency}</DialogTitle>
            <DialogDescription>
              This changes how new accounting amounts are measured. Posted history is never rewritten.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            {readiness?.requires_confirmation && (
              <div className="space-y-2 rounded-md border p-4 text-sm">
                <p className="font-medium">Affected setup</p>
                <ul className="space-y-1 text-muted-foreground">
                  {readiness.draft_total > 0 && <li>{readiness.draft_total} draft documents will be re-stamped</li>}
                  {readiness.foreign_bank_account_count > 0 && <li>{readiness.foreign_bank_account_count} bank accounts use the current or another currency</li>}
                  {readiness.non_base_operating_currency_count > 0 && <li>{readiness.non_base_operating_currency_count} additional operating currencies are enabled</li>}
                  {readiness.reconciliation_count > 0 && <li>{readiness.reconciliation_count} reconciliation sessions exist</li>}
                  {readiness.closed_period_count > 0 && <li>{readiness.closed_period_count} closed periods exist</li>}
                </ul>
              </div>
            )}
            <div className="space-y-2">
              <Label htmlFor="base-currency-reason">Reason</Label>
              <Input
                id="base-currency-reason"
                value={changeReason}
                onChange={(event) => setChangeReason(event.target.value)}
                placeholder="Why is the company changing its accounting currency?"
              />
            </div>
            <Button className="w-full" onClick={handleSaveBaseCurrency} disabled={isSaving || !changeReason.trim()}>
              {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Confirm change
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
          <div className="space-y-1.5">
            <CardTitle className="flex items-center gap-2">
              Operating Currencies
              <Badge variant="secondary" className="font-normal">
                {enabledCount} of {currencies.length} enabled
              </Badge>
            </CardTitle>
            <CardDescription>
              Currencies this company is allowed to transact in. The base currency is always
              enabled and cannot be switched off. Any other currency must be enabled here
              before a document can be raised in it — and it still needs a rate on file.
            </CardDescription>
          </div>
          <Button
            variant="outline"
            size="sm"
            className="shrink-0"
            onClick={() => setCurrencyPickerOpen((v) => !v)}
            aria-expanded={currencyPickerOpen}
          >
            {currencyPickerOpen ? (
              <>
                <ChevronUp className="mr-2 h-4 w-4" />
                Done
              </>
            ) : (
              <>
                <ChevronDown className="mr-2 h-4 w-4" />
                Manage currencies
              </>
            )}
          </Button>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Collapsed summary — only what this company actually uses. */}
          <div className="flex flex-wrap gap-2">
            {enabledCurrencies.length === 0 ? (
              <p className="text-sm text-muted-foreground">
                No currencies enabled yet.
              </p>
            ) : (
              enabledCurrencies.map((c) => (
                <Badge
                  key={c.id}
                  variant={isBaseCode(c.code) ? "default" : "secondary"}
                  className="gap-1.5 py-1 font-normal"
                >
                  <span className="font-medium">{c.code}</span>
                  <span className="text-[11px] opacity-80">{c.name}</span>
                  {isBaseCode(c.code) && <LockKeyhole className="h-3 w-3" />}
                </Badge>
              ))
            )}
          </div>

          {currencyPickerOpen && (
            <div className="space-y-3 rounded-md border p-3">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={currencyQuery}
                    onChange={(e) => setCurrencyQuery(e.target.value)}
                    placeholder="Search by code or name (e.g. KES, Euro)"
                    className="pl-8"
                    aria-label="Search currencies"
                  />
                </div>
                <div className="flex gap-1 rounded-md border p-0.5">
                  {(["all", "enabled", "available"] as const).map((f) => (
                    <Button
                      key={f}
                      type="button"
                      size="sm"
                      variant={currencyFilter === f ? "secondary" : "ghost"}
                      className="h-7 px-3 text-xs capitalize"
                      onClick={() => setCurrencyFilter(f)}
                    >
                      {f}
                    </Button>
                  ))}
                </div>
              </div>

              <ScrollArea className="h-[300px] pr-3">
                {visibleCurrencies.length === 0 ? (
                  <p className="py-8 text-center text-sm text-muted-foreground">
                    No currency matches “{currencyQuery}”.
                  </p>
                ) : (
                  <div className="grid gap-1.5 sm:grid-cols-2 lg:grid-cols-3">
                    {visibleCurrencies.map((c) => {
                      const isBase = isBaseCode(c.code);
                      return (
                        <label
                          key={c.id}
                          className="flex items-center justify-between gap-3 rounded-md border px-3 py-2 text-sm hover:bg-muted/50"
                        >
                          <span className="min-w-0">
                            <span className="font-medium">{c.code}</span>
                            <span className="ml-2 truncate text-xs text-muted-foreground">
                              {c.name}
                            </span>
                          </span>
                          <span className="flex shrink-0 items-center gap-2">
                            {isBase && (
                              <Badge variant="outline" className="text-[10px]">
                                Base
                              </Badge>
                            )}
                            <Switch
                              checked={isBase || enabledSet.has(c.code)}
                              disabled={!canEdit || isBase}
                              onCheckedChange={(v) => handleToggleCurrency(c.code, v)}
                              aria-label={`Enable ${c.code}`}
                            />
                          </span>
                        </label>
                      );
                    })}
                  </div>
                )}
              </ScrollArea>
              <p className="text-xs text-muted-foreground">
                Showing {visibleCurrencies.length} of {currencies.length} catalogue
                currencies.
              </p>
            </div>
          )}
        </CardContent>
      </Card>


      <FxRateCoverageCard
        summary={coverage}
        isLoading={coverageLoading}
        error={coverageError}
        canEdit={canEdit}
        onRefresh={() => void refreshCoverage()}
        onRecordRate={openRateForGap}
      />

      <Card>
        <CardHeader className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
          <div>
            <CardTitle className="flex items-center gap-2">
              Rate Book
              <Badge variant="secondary" className="font-normal">
                {exchangeRates.length} {exchangeRates.length === 1 ? "rate" : "rates"}
              </Badge>
            </CardTitle>
            <CardDescription>
              Every rate the company can use, and where it came from. Overrides win over
              manual rates, which win over platform rates; the most recent effective date
              wins. Documents keep the rate they were stamped with. Rates are never edited
              or deleted — a correction is recorded as a new dated override.
            </CardDescription>
          </div>
          {canEdit && (
            <Button size="sm" className="shrink-0" onClick={() => setShowRateDialog(true)} disabled={!base}>
              <Plus className="mr-2 h-4 w-4" />
              Add override
            </Button>
          )}
        </CardHeader>
        <CardContent className="space-y-3">
          {exchangeRates.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">
              No rates on file. Foreign-currency documents will be refused until a rate
              exists — they are never posted at 1:1.
            </p>
          ) : (
            <>
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <div className="relative flex-1">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={rateQuery}
                    onChange={(e) => {
                      setRateQuery(e.target.value);
                      setRatePage(1);
                    }}
                    placeholder="Search a pair or provider (e.g. USD, EUR/KES)"
                    className="pl-8"
                    aria-label="Search rate book"
                  />
                </div>
                <div className="flex gap-1 rounded-md border p-0.5">
                  {(["all", "override", "manual", "provider"] as const).map((f) => (
                    <Button
                      key={f}
                      type="button"
                      size="sm"
                      variant={rateSource === f ? "secondary" : "ghost"}
                      className="h-7 px-2.5 text-xs"
                      onClick={() => {
                        setRateSource(f);
                        setRatePage(1);
                      }}
                    >
                      {f === "all" ? "All" : (SOURCE_LABEL[f] ?? f)}
                    </Button>
                  ))}
                </div>
              </div>

              {filteredRates.length === 0 ? (
                <p className="py-8 text-center text-sm text-muted-foreground">
                  No rate matches this search.
                </p>
              ) : (
                <>
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
                        </TableRow>
                      </TableHeader>
                      <TableBody>
                        {pagedRates.map((rate) => (
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
                          </TableRow>
                        ))}
                      </TableBody>
                    </Table>
                  </div>

                  <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
                    <p className="text-xs text-muted-foreground">
                      Showing {rangeStart}–{rangeEnd} of {filteredRates.length}
                      {filteredRates.length !== exchangeRates.length &&
                        ` (filtered from ${exchangeRates.length})`}
                    </p>
                    {totalRatePages > 1 && (
                      <div className="flex items-center gap-2">
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRatePage((p) => Math.max(1, p - 1))}
                          disabled={ratePage === 1}
                        >
                          Previous
                        </Button>
                        <span className="text-xs text-muted-foreground">
                          Page {ratePage} of {totalRatePages}
                        </span>
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => setRatePage((p) => Math.min(totalRatePages, p + 1))}
                          disabled={ratePage === totalRatePages}
                        >
                          Next
                        </Button>
                      </div>
                    )}
                  </div>
                </>
              )}
            </>
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
