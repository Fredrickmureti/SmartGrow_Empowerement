import { useState } from "react";
import { Check, Layers, MapPin, Search } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useBranch } from "@/contexts/BranchContext";

interface ContextSwitcherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * When true, render a "Reporting view" block with an
   * "All Branches (Consolidated)" option above the Branch list.
   */
  consolidatedAvailable?: boolean;
  consolidatedActive?: boolean;
  onSetConsolidated?: (v: boolean) => void;
}

/**
 * Branch/reporting-scope switcher for the single-institution model.
 *
 * The institution (workspace + company) is a fixed configuration root, so no
 * workspace or company switching / creation is offered here. Only branch
 * scope and the consolidated reporting view are switchable.
 */
export function ContextSwitcherSheet({
  open,
  onOpenChange,
  consolidatedAvailable = false,
  consolidatedActive = false,
  onSetConsolidated,
}: ContextSwitcherSheetProps) {
  const { branches, currentBranch, switchBranch } = useBranch();
  const [branchSearch, setBranchSearch] = useState("");

  const showBranchList = branches.length >= 2;
  const showConsolidatedSection =
    consolidatedAvailable && !!onSetConsolidated && branches.length >= 1;
  const isCompletelyEmpty = !showBranchList && !showConsolidatedSection;

  const filteredBranches = branches.filter(b =>
    b.name.toLowerCase().includes(branchSearch.toLowerCase())
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[340px] sm:w-[380px] p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="text-base">Switch Scope</SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 pb-5 space-y-1">
            {isCompletelyEmpty && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                You're scoped to a single branch. There's nothing to switch to.
              </div>
            )}

            {showBranchList && (
              <>
                <SectionHeader icon={MapPin} label="Branch" />
                {branches.length > 5 && (
                  <SearchInput value={branchSearch} onChange={setBranchSearch} placeholder="Search branches..." />
                )}
                <div className="space-y-0.5">
                  {filteredBranches.map(branch => (
                    <SwitcherItem
                      key={branch.id}
                      label={branch.name}
                      subtitle={branch.is_headquarters ? "HQ" : undefined}
                      active={!consolidatedActive && currentBranch?.id === branch.id}
                      onClick={() => {
                        if (consolidatedActive && onSetConsolidated) onSetConsolidated(false);
                        switchBranch(branch.id);
                        onOpenChange(false);
                      }}
                    />
                  ))}
                </div>
              </>
            )}

            {showConsolidatedSection && (
              <>
                {showBranchList && <Separator className="!my-3" />}
                <SectionHeader icon={Layers} label="Reporting view" />
                <div className="space-y-0.5">
                  <SwitcherItem
                    label="All Branches (Consolidated)"
                    subtitle="Cross-branch totals"
                    active={consolidatedActive}
                    onClick={() => {
                      onSetConsolidated?.(true);
                      onOpenChange(false);
                    }}
                  />
                </div>
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function SectionHeader({ icon: Icon, label }: { icon: React.ElementType; label: string }) {
  return (
    <div className="flex items-center gap-2 py-2">
      <Icon className="h-3.5 w-3.5 text-muted-foreground" />
      <span className="text-[11px] font-semibold uppercase tracking-wider text-muted-foreground">
        {label}
      </span>
    </div>
  );
}

function SearchInput({ value, onChange, placeholder }: { value: string; onChange: (v: string) => void; placeholder: string }) {
  return (
    <div className="relative mb-1">
      <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-muted-foreground" />
      <Input
        value={value}
        onChange={e => onChange(e.target.value)}
        placeholder={placeholder}
        className="h-8 pl-8 text-xs"
      />
    </div>
  );
}

function SwitcherItem({
  label,
  subtitle,
  active,
  logoUrl,
  initials,
  onClick,
}: {
  label: string;
  subtitle?: string;
  active: boolean;
  logoUrl?: string | null;
  initials?: string;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        "w-full flex items-center gap-3 rounded-lg px-3 py-2 text-sm transition-colors text-left",
        active
          ? "bg-primary/10 text-primary font-medium"
          : "text-foreground hover:bg-secondary"
      )}
    >
      {(logoUrl || initials) && (
        <div className="flex h-6 w-6 items-center justify-center rounded bg-secondary text-[10px] font-semibold shrink-0 overflow-hidden">
          {logoUrl ? (
            <img src={logoUrl} alt={label} className="h-full w-full object-cover" />
          ) : (
            initials
          )}
        </div>
      )}
      <div className="flex-1 min-w-0">
        <span className="truncate block">{label}</span>
        {subtitle && <span className="text-[10px] text-muted-foreground">{subtitle}</span>}
      </div>
      {active && <Check className="h-4 w-4 shrink-0 text-primary" />}
    </button>
  );
}
