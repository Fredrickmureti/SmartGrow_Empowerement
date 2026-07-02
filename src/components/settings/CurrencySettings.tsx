import { useState, useEffect } from "react";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useCurrency } from "@/hooks/useCurrency";
import { usePermissions } from "@/hooks/usePermissions";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
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

interface ExchangeRate {
  id: string;
  from_currency: string;
  to_currency: string;
  rate: number;
  effective_date: string;
}

export function CurrencySettings() {
  const { currentOrg } = useOrganization();
  const { currentBusiness, refreshBusinesses } = useBusinesses();
  const { canManageCurrency } = usePermissions();
  const { formatCurrency } = useCurrency();
  const { toast } = useToast();
  const [currencies, setCurrencies] = useState<Currency[]>([]);
  const [exchangeRates, setExchangeRates] = useState<ExchangeRate[]>([]);
  const [baseCurrency, setBaseCurrency] = useState("");
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [showRateDialog, setShowRateDialog] = useState(false);
  const [rateForm, setRateForm] = useState({
    from_currency: "",
    to_currency: "",
    rate: 1,
    createReverse: true,
  });

  const canEdit = canManageCurrency;

  useEffect(() => {
    fetchCurrencies();
    fetchExchangeRates();
    if (currentBusiness) {
      setBaseCurrency(currentBusiness.base_currency ?? "");
    }
  }, [currentBusiness, currentOrg]);

  const fetchCurrencies = async () => {
    try {
      const { data, error } = await supabase
        .from("currencies")
        .select("*")
        .eq("is_active", true)
        .order("code");
      if (error) throw error;
      setCurrencies(data || []);
    } catch (error) {
      console.error("Error fetching currencies:", error);
    } finally {
      setIsLoading(false);
    }
  };

  const fetchExchangeRates = async () => {
    if (!currentOrg || !currentBusiness) return;
    try {
      // Phase D fix: exchange_rates carries business_id NOT NULL — different
      // companies in the same workspace can hold reserves in different
      // currencies, so FX rates are per-company, not per-workspace.
      const { data, error } = await supabase
        .from("exchange_rates")
        .select("*")
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .order("effective_date", { ascending: false });
      if (error) throw error;
      setExchangeRates(data || []);
    } catch (error) {
      console.error("Error fetching exchange rates:", error);
    }
  };

  const handleSaveBaseCurrency = async () => {
    if (!currentBusiness || !canEdit) return;
    setIsSaving(true);
    try {
      // Phase-7: base_currency lives on businesses, NOT organizations.
      // Note: trg_business_currency_lock will reject changes after the first JE.
      const { error } = await supabase
        .from("businesses")
        .update({ base_currency: baseCurrency })
        .eq("id", currentBusiness.id);
      if (error) throw error;
      toast({ title: "Base currency updated" });
      await refreshBusinesses();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : "Failed to update base currency";
      toast({
        title: "Error",
        description: message,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleAddExchangeRate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentOrg || !currentBusiness) return;
    setIsSaving(true);
    try {
      const ratesToInsert = [
        {
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          from_currency: rateForm.from_currency,
          to_currency: rateForm.to_currency,
          rate: rateForm.rate,
          effective_date: new Date().toISOString().split("T")[0],
        },
      ];

      // Add reverse rate if checkbox is checked
      if (rateForm.createReverse && rateForm.rate > 0) {
        ratesToInsert.push({
          organization_id: currentOrg.id,
          business_id: currentBusiness.id,
          from_currency: rateForm.to_currency,
          to_currency: rateForm.from_currency,
          rate: 1 / rateForm.rate,
          effective_date: new Date().toISOString().split("T")[0],
        });
      }

      const { error } = await supabase.from("exchange_rates").insert(ratesToInsert);
      if (error) throw error;
      toast({ title: rateForm.createReverse ? "Exchange rates added (including reverse)" : "Exchange rate added" });
      setShowRateDialog(false);
      setRateForm({ from_currency: "", to_currency: "", rate: 1, createReverse: true });
      fetchExchangeRates();
    } catch (error: any) {
      toast({
        title: "Error",
        description: normalizeError(error).message,
        variant: "destructive",
      });
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteRate = async (id: string) => {
    if (!confirm("Delete this exchange rate?")) return;
    if (!currentOrg?.id || !currentBusiness?.id) {
      toast({ title: "Select a Company first", variant: "destructive" });
      return;
    }
    try {
      // Belt-and-braces: scope delete by org+business as well as id.
      const { error } = await supabase
        .from("exchange_rates")
        .delete()
        .eq("id", id)
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id);
      if (error) throw error;
      toast({ title: "Exchange rate deleted" });
      fetchExchangeRates();
    } catch (error: any) {
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

  return (
    <div className="space-y-6">
      <Card>
        <CardHeader>
          <CardTitle>Base Currency</CardTitle>
          <CardDescription>
            Set the default currency for your organization
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex gap-4 items-end max-w-md">
            <div className="flex-1 space-y-2">
              <Label>Default Currency</Label>
              <Select
                value={baseCurrency}
                onValueChange={setBaseCurrency}
                disabled={!canEdit}
              >
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
        <CardHeader className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
          <div>
            <CardTitle>Exchange Rates</CardTitle>
            <CardDescription>
              Manage currency exchange rates for multi-currency transactions
            </CardDescription>
          </div>
          {canEdit && (
            <Button size="sm" onClick={() => setShowRateDialog(true)}>
              <Plus className="mr-2 h-4 w-4" />
              Add Rate
            </Button>
          )}
        </CardHeader>
        <CardContent>
          {exchangeRates.length === 0 ? (
            <p className="text-muted-foreground text-sm py-4 text-center">
              No exchange rates configured
            </p>
          ) : (
            <div className="overflow-x-auto -mx-4 px-4 sm:mx-0 sm:px-0">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>From</TableHead>
                    <TableHead>To</TableHead>
                    <TableHead>Rate</TableHead>
                    <TableHead className="hidden sm:table-cell">Effective Date</TableHead>
                    {canEdit && <TableHead className="w-12"></TableHead>}
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {exchangeRates.map((rate) => (
                    <TableRow key={rate.id}>
                      <TableCell>{rate.from_currency}</TableCell>
                      <TableCell>{rate.to_currency}</TableCell>
                      <TableCell>{rate.rate}</TableCell>
                      <TableCell className="hidden sm:table-cell">{rate.effective_date}</TableCell>
                      {canEdit && (
                        <TableCell>
                          <Button
                            variant="ghost"
                            size="icon"
                            onClick={() => handleDeleteRate(rate.id)}
                          >
                            <Trash2 className="h-4 w-4 text-destructive" />
                          </Button>
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
            <DialogTitle>Add Exchange Rate</DialogTitle>
          </DialogHeader>
          <form onSubmit={handleAddExchangeRate} className="space-y-4">
            <div className="grid gap-4 grid-cols-2">
              <div className="space-y-2">
                <Label>From Currency</Label>
                <Select
                  value={rateForm.from_currency}
                  onValueChange={(v) => setRateForm({ ...rateForm, from_currency: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies.map((c) => (
                      <SelectItem key={c.id} value={c.code}>
                        {c.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
              <div className="space-y-2">
                <Label>To Currency</Label>
                <Select
                  value={rateForm.to_currency}
                  onValueChange={(v) => setRateForm({ ...rateForm, to_currency: v })}
                >
                  <SelectTrigger>
                    <SelectValue placeholder="Select" />
                  </SelectTrigger>
                  <SelectContent>
                    {currencies.map((c) => (
                      <SelectItem key={c.id} value={c.code}>
                        {c.code}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
            <div className="space-y-2">
              <Label>Exchange Rate</Label>
              <Input
                type="number"
                step="0.0001"
                min="0"
                value={rateForm.rate}
                onChange={(e) =>
                  setRateForm({ ...rateForm, rate: parseFloat(e.target.value) || 0 })
                }
                required
              />
              <div className="space-y-1 pt-2">
                <p className="text-sm font-medium">
                  1 {rateForm.from_currency || "FROM"} = {rateForm.rate.toFixed(4)}{" "}
                  {rateForm.to_currency || "TO"}
                </p>
                {rateForm.rate > 0 && (
                  <p className="text-xs text-muted-foreground">
                    Reverse: 1 {rateForm.to_currency || "TO"} = {(1 / rateForm.rate).toFixed(4)}{" "}
                    {rateForm.from_currency || "FROM"}
                  </p>
                )}
              </div>
            </div>
            <div className="flex items-center space-x-2">
              <input
                type="checkbox"
                id="createReverse"
                checked={rateForm.createReverse}
                onChange={(e) => setRateForm({ ...rateForm, createReverse: e.target.checked })}
                className="h-4 w-4 rounded border-gray-300"
              />
              <Label htmlFor="createReverse" className="text-sm font-normal">
                Also create reverse rate automatically
              </Label>
            </div>
            <div className="flex justify-end gap-2">
              <Button
                type="button"
                variant="outline"
                onClick={() => setShowRateDialog(false)}
              >
                Cancel
              </Button>
              <Button type="submit" disabled={isSaving}>
                {isSaving && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
                Add Rate
              </Button>
            </div>
          </form>
        </DialogContent>
      </Dialog>
    </div>
  );
}
