/**
 * ParentCompanyCombobox
 *
 * Enterprise picker for `contacts.parent_contact_id`. Replaces the legacy
 * `<Select>` which iterated the page's paginated `contacts` array and so
 * silently hid most companies past page 1.
 *
 * Behaviour:
 *  - Searches `contacts` directly, scoped to (organization_id, business_id),
 *    filtered by `is_company = true`.
 *  - Debounced server-side search by name / email / tax_id.
 *  - Inline "+ Create new company" action: opens a lightweight nested
 *    dialog that creates a company-typed contact and immediately selects it.
 *
 * The component is intentionally domain-agnostic of the surrounding form
 * (Contacts dialog, LeadForm conversion, etc.) — it only owns the picker.
 */
import { useEffect, useMemo, useState } from "react";
import { Check, ChevronsUpDown, Building2, Plus, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandSeparator,
} from "@/components/ui/command";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { supabase } from "@/integrations/supabase/client";
import { applyPartyScope } from "@/lib/contactAddresses";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/hooks/useBusinesses";
import { useContacts } from "@/hooks/useContacts";
import { useToast } from "@/hooks/use-toast";

interface CompanyRow {
  id: string;
  name: string;
  city: string | null;
  country: string | null;
  email: string | null;
}

interface ParentCompanyComboboxProps {
  /** `null` means "no parent" (top-level individual / standalone). */
  value: string | null;
  onValueChange: (id: string | null) => void;
  /** Optional id to hide from the list (prevent self-parenting on edit). */
  excludeId?: string;
  disabled?: boolean;
  placeholder?: string;
}

export function ParentCompanyCombobox({
  value,
  onValueChange,
  excludeId,
  disabled = false,
  placeholder = "Search for a company…",
}: ParentCompanyComboboxProps) {
  const { currentOrg } = useOrganization();
  const { currentBusiness } = useBusinesses();
  const { createContact, refreshContacts } = useContacts();
  const { toast } = useToast();

  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const [debounced, setDebounced] = useState("");
  const [rows, setRows] = useState<CompanyRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [selected, setSelected] = useState<CompanyRow | null>(null);

  // Inline "create company" dialog state
  const [createOpen, setCreateOpen] = useState(false);
  const [newName, setNewName] = useState("");
  const [creating, setCreating] = useState(false);

  // Debounce search input (server-side query).
  useEffect(() => {
    const t = setTimeout(() => setDebounced(search.trim()), 200);
    return () => clearTimeout(t);
  }, [search]);

  // Hydrate the currently-selected value (needed when editing an existing contact).
  useEffect(() => {
    let cancelled = false;
    if (!value) {
      setSelected(null);
      return;
    }
    if (selected?.id === value) return;
    (async () => {
      const { data } = await supabase
        .from("contacts")
        .select("id, name, city, country, email")
        .eq("id", value)
        .maybeSingle();
      if (!cancelled && data) setSelected(data as CompanyRow);
    })();
    return () => {
      cancelled = true;
    };
  }, [value, selected?.id]);

  // Fetch matching companies whenever the popover is open and search changes.
  useEffect(() => {
    if (!open || !currentOrg || !currentBusiness) return;
    let cancelled = false;
    setLoading(true);
    (async () => {
      let query = applyPartyScope(
        supabase
          .from("contacts")
          .select("id, name, city, country, email"),
      )
        .eq("organization_id", currentOrg.id)
        .eq("business_id", currentBusiness.id)
        .eq("is_company", true)
        .eq("is_active", true)
        .order("name")
        .limit(50);

      if (debounced.length > 0) {
        // Match on name OR email OR tax_id (Odoo-style master-data search).
        const q = debounced.replace(/[%,()]/g, "");
        query = query.or(
          `name.ilike.%${q}%,email.ilike.%${q}%,tax_id.ilike.%${q}%`,
        );
      }

      const { data, error } = await query;
      if (cancelled) return;
      if (error) {
        console.error("ParentCompanyCombobox search failed:", error);
        setRows([]);
      } else {
        setRows((data ?? []).filter((r) => r.id !== excludeId) as CompanyRow[]);
      }
      setLoading(false);
    })();
    return () => {
      cancelled = true;
    };
  }, [open, debounced, currentOrg?.id, currentBusiness?.id, excludeId]);

  const subtitleFor = (r: CompanyRow) => {
    const bits = [r.city, r.country].filter(Boolean);
    return bits.length ? bits.join(", ") : r.email ?? "";
  };

  const triggerLabel = useMemo(() => {
    if (selected) return selected.name;
    if (value) return "Loading…";
    return placeholder;
  }, [selected, value, placeholder]);

  const handleCreate = async () => {
    const name = newName.trim();
    if (!name) return;
    setCreating(true);
    try {
      const created: any = await createContact({
        name,
        type: "customer",
        is_company: true,
        is_active: true,
      } as any);
      if (created?.id) {
        const row: CompanyRow = {
          id: created.id,
          name: created.name,
          city: created.city ?? null,
          country: created.country ?? null,
          email: created.email ?? null,
        };
        setSelected(row);
        onValueChange(created.id);
        await refreshContacts();
        toast({ title: "Company created", description: name });
      }
      setCreateOpen(false);
      setNewName("");
    } catch (err: any) {
      toast({
        title: "Couldn't create company",
        description: err?.message ?? "Unknown error",
        variant: "destructive",
      });
    } finally {
      setCreating(false);
    }
  };

  return (
    <>
      <Popover open={open} onOpenChange={setOpen}>
        <PopoverTrigger asChild>
          <Button
            type="button"
            variant="outline"
            role="combobox"
            aria-expanded={open}
            disabled={disabled}
            className={cn(
              "w-full justify-between font-normal h-9 text-left",
              !value && "text-muted-foreground",
            )}
          >
            <span className="flex items-center gap-2 truncate">
              {value && <Building2 className="h-4 w-4 shrink-0 opacity-70" />}
              <span className="truncate">{triggerLabel}</span>
            </span>
            <ChevronsUpDown className="ml-2 h-4 w-4 shrink-0 opacity-50" />
          </Button>
        </PopoverTrigger>
        <PopoverContent className="w-[360px] p-0" align="start">
          <Command shouldFilter={false}>
            <CommandInput
              placeholder="Search by name, email, or tax ID…"
              value={search}
              onValueChange={setSearch}
            />
            <CommandList className="max-h-[300px]">
              {loading ? (
                <div className="flex items-center justify-center py-6 text-sm text-muted-foreground">
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Searching…
                </div>
              ) : (
                <>
                  <CommandEmpty>
                    {debounced
                      ? `No companies match "${debounced}".`
                      : "No companies yet."}
                  </CommandEmpty>
                  {value && (
                    <CommandGroup>
                      <CommandItem
                        value="__clear"
                        onSelect={() => {
                          onValueChange(null);
                          setSelected(null);
                          setOpen(false);
                        }}
                      >
                        <Check className="mr-2 h-4 w-4 opacity-0" />
                        <span className="text-muted-foreground">
                          Clear selection (no parent)
                        </span>
                      </CommandItem>
                    </CommandGroup>
                  )}
                  {rows.length > 0 && (
                    <CommandGroup heading="Companies">
                      {rows.map((r) => {
                        const sub = subtitleFor(r);
                        return (
                          <CommandItem
                            key={r.id}
                            value={r.id}
                            onSelect={() => {
                              onValueChange(r.id);
                              setSelected(r);
                              setOpen(false);
                            }}
                          >
                            <Check
                              className={cn(
                                "mr-2 h-4 w-4",
                                value === r.id ? "opacity-100" : "opacity-0",
                              )}
                            />
                            <Building2 className="mr-2 h-4 w-4 shrink-0 opacity-70" />
                            <div className="flex min-w-0 flex-col">
                              <span className="truncate">{r.name}</span>
                              {sub && (
                                <span className="truncate text-xs text-muted-foreground">
                                  {sub}
                                </span>
                              )}
                            </div>
                          </CommandItem>
                        );
                      })}
                    </CommandGroup>
                  )}
                </>
              )}
              <CommandSeparator />
              <CommandGroup>
                <CommandItem
                  value="__create"
                  onSelect={() => {
                    setNewName(search.trim());
                    setOpen(false);
                    setCreateOpen(true);
                  }}
                >
                  <Plus className="mr-2 h-4 w-4" />
                  <span>
                    Create new company
                    {search.trim() ? ` "${search.trim()}"` : ""}
                  </span>
                </CommandItem>
              </CommandGroup>
            </CommandList>
          </Command>
        </PopoverContent>
      </Popover>

      <Dialog open={createOpen} onOpenChange={setCreateOpen}>
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>New company</DialogTitle>
            <DialogDescription>
              Create a company contact you can attach this individual to. You
              can fill in the rest of the company's details later from the
              Contacts list.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 py-2">
            <Label htmlFor="new-company-name">Company name</Label>
            <Input
              id="new-company-name"
              autoFocus
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="Acme Corporation"
              onKeyDown={(e) => {
                if (e.key === "Enter" && newName.trim() && !creating) {
                  e.preventDefault();
                  handleCreate();
                }
              }}
            />
          </div>
          <DialogFooter>
            <Button
              type="button"
              variant="ghost"
              onClick={() => setCreateOpen(false)}
              disabled={creating}
            >
              Cancel
            </Button>
            <Button
              type="button"
              onClick={handleCreate}
              disabled={creating || !newName.trim()}
            >
              {creating && <Loader2 className="mr-2 h-4 w-4 animate-spin" />}
              Create company
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
