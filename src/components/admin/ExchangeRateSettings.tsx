// @ts-nocheck - Admin tables not in auto-generated types
import { useMemo, useState } from "react";
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
import { Separator } from "@/components/ui/separator";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { useAdminCurrency } from "@/hooks/useAdminCurrency";
import { ArrowRightLeft, Loader2, Plus, Save, X } from "lucide-react";
import { format } from "date-fns";
import { toast } from "sonner";

export function ExchangeRateSettings() {
  const {
    exchangeRates,
    isLoadingRates,
    updateRate,
    createRate,
    isUpdatingRate,
    isCreatingRate,
  } = useAdminCurrency();

  const [editingId, setEditingId] = useState<string | null>(null);
  const [draftRate, setDraftRate] = useState<string>("");

  // "New currency" dialog state
  const [newOpen, setNewOpen] = useState(false);
  const [newCode, setNewCode] = useState("");
  const [newName, setNewName] = useState("");
  const [newSymbol, setNewSymbol] = useState("");
  const [newRateValue, setNewRateValue] = useState("");

  // Show every USD-anchored rate, sorted with USD pinned first.
  const sortedRates = useMemo(() => {
    const list = (exchangeRates ?? []).filter(
      (r) => r.from_currency === "USD" || r.to_currency === "USD",
    );
    return list.sort((a, b) => {
      const aTarget = a.from_currency === "USD" ? a.to_currency : a.from_currency;
      const bTarget = b.from_currency === "USD" ? b.to_currency : b.from_currency;
      if (aTarget === "USD") return -1;
      if (bTarget === "USD") return 1;
      return aTarget.localeCompare(bTarget);
    });
  }, [exchangeRates]);

  const handleSave = (id: string) => {
    const value = parseFloat(draftRate);
    if (!isFinite(value) || value <= 0) {
      toast.error("Rate must be a positive number");
      return;
    }
    updateRate({ id, rate: value });
    setEditingId(null);
    setDraftRate("");
  };

  const handleCreate = () => {
    const code = newCode.trim().toUpperCase();
    const value = parseFloat(newRateValue);
    if (code.length !== 3 || !/^[A-Z]{3}$/.test(code)) {
      toast.error("Currency code must be a 3-letter ISO code (e.g. INR)");
      return;
    }
    if (!isFinite(value) || value <= 0) {
      toast.error("Rate must be a positive number");
      return;
    }
    createRate({
      from_currency: "USD",
      to_currency: code,
      rate: value,
      display_name: newName.trim() || code,
      symbol: newSymbol.trim() || code,
    });
    setNewOpen(false);
    setNewCode("");
    setNewName("");
    setNewSymbol("");
    setNewRateValue("");
  };

  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3">
        <div>
          <CardTitle className="flex items-center gap-2 text-base">
            <ArrowRightLeft className="h-5 w-5" />
            Exchange Rates
          </CardTitle>
          <CardDescription>
            All figures are stored in USD. These rates drive the per-admin
            display currency picker.
          </CardDescription>
        </div>
        <Dialog open={newOpen} onOpenChange={setNewOpen}>
          <DialogTrigger asChild>
            <Button size="sm" variant="outline" className="gap-1.5">
              <Plus className="h-3.5 w-3.5" />
              Add currency
            </Button>
          </DialogTrigger>
          <DialogContent className="sm:max-w-md">
            <DialogHeader>
              <DialogTitle>Add a display currency</DialogTitle>
              <DialogDescription>
                Adds a USD → target conversion. Use a 3-letter ISO 4217 code.
              </DialogDescription>
            </DialogHeader>
            <div className="space-y-3">
              <div className="space-y-1.5">
                <Label htmlFor="cur-code">ISO code</Label>
                <Input
                  id="cur-code"
                  value={newCode}
                  onChange={(e) => setNewCode(e.target.value.toUpperCase())}
                  placeholder="INR"
                  maxLength={3}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="cur-name">Display name</Label>
                  <Input
                    id="cur-name"
                    value={newName}
                    onChange={(e) => setNewName(e.target.value)}
                    placeholder="Indian Rupee"
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="cur-symbol">Symbol</Label>
                  <Input
                    id="cur-symbol"
                    value={newSymbol}
                    onChange={(e) => setNewSymbol(e.target.value)}
                    placeholder="₹"
                    maxLength={4}
                  />
                </div>
              </div>
              <div className="space-y-1.5">
                <Label htmlFor="cur-rate">1 USD = …</Label>
                <Input
                  id="cur-rate"
                  type="number"
                  step="0.0001"
                  min="0"
                  value={newRateValue}
                  onChange={(e) => setNewRateValue(e.target.value)}
                  placeholder="83.20"
                />
              </div>
            </div>
            <DialogFooter>
              <Button variant="ghost" onClick={() => setNewOpen(false)}>
                Cancel
              </Button>
              <Button onClick={handleCreate} disabled={isCreatingRate}>
                {isCreatingRate && (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                )}
                Add currency
              </Button>
            </DialogFooter>
          </DialogContent>
        </Dialog>
      </CardHeader>
      <CardContent className="space-y-2">
        {isLoadingRates ? (
          <div className="flex items-center justify-center py-8">
            <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
          </div>
        ) : sortedRates.length === 0 ? (
          <div className="text-center text-sm text-muted-foreground py-8">
            No exchange rates configured yet. Add one to enable display in
            other currencies.
          </div>
        ) : (
          <div className="divide-y rounded-lg border">
            {sortedRates.map((r) => {
              const target =
                r.from_currency === "USD" ? r.to_currency : r.from_currency;
              const isEditing = editingId === r.id;
              return (
                <div
                  key={r.id}
                  className="flex items-center gap-3 px-4 py-3"
                >
                  <div className="h-9 w-9 rounded-full bg-muted flex items-center justify-center text-sm font-semibold">
                    {r.symbol || target}
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-sm">
                        {r.display_name || target}
                      </span>
                      <Badge variant="outline" className="text-[10px]">
                        {r.from_currency} → {r.to_currency}
                      </Badge>
                    </div>
                    <p className="text-xs text-muted-foreground">
                      Updated{" "}
                      {format(
                        new Date(r.updated_at),
                        "MMM d, yyyy 'at' h:mm a",
                      )}
                    </p>
                  </div>
                  {isEditing ? (
                    <div className="flex items-center gap-1.5">
                      <Input
                        type="number"
                        step="0.0001"
                        min="0"
                        value={draftRate}
                        onChange={(e) => setDraftRate(e.target.value)}
                        className="w-32 h-8 text-sm"
                      />
                      <Button
                        size="sm"
                        onClick={() => handleSave(r.id)}
                        disabled={isUpdatingRate}
                      >
                        {isUpdatingRate ? (
                          <Loader2 className="h-3.5 w-3.5 animate-spin" />
                        ) : (
                          <Save className="h-3.5 w-3.5" />
                        )}
                      </Button>
                      <Button
                        size="icon"
                        variant="ghost"
                        className="h-8 w-8"
                        onClick={() => {
                          setEditingId(null);
                          setDraftRate("");
                        }}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => {
                        setEditingId(r.id);
                        setDraftRate(String(r.rate));
                      }}
                      className="text-sm font-mono tabular-nums hover:underline"
                    >
                      {Number(r.rate).toLocaleString(undefined, {
                        maximumFractionDigits: 4,
                      })}
                    </button>
                  )}
                </div>
              );
            })}
          </div>
        )}

        <Separator className="my-3" />
        <div className="p-3 rounded-md bg-muted/40 border text-xs text-muted-foreground space-y-1">
          <p>
            <strong>Display only.</strong> Changing a rate does not rewrite
            historical data — it only changes how the admin console renders
            USD-stored figures for the operator that picks that currency.
          </p>
          <p>
            For a live feed (ECB / openexchangerates), connect a provider in
            Infrastructure → Providers and the system will refresh these
            rates daily.
          </p>
        </div>
      </CardContent>
    </Card>
  );
}
