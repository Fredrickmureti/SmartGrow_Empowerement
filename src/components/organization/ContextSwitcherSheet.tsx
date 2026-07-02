import { useState } from "react";
import { Check, Plus, Building, Building2, Layers, MapPin, Search } from "lucide-react";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Separator } from "@/components/ui/separator";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { cn } from "@/lib/utils";
import { useOrganization } from "@/hooks/useOrganization";
import { useBusinesses } from "@/contexts/BusinessContext";
import { useBranch } from "@/contexts/BranchContext";
import { usePermissions } from "@/hooks/usePermissions";
import { industryTypes } from "@/lib/countryCurrency";

const industryLabel = (industry?: string | null): string | undefined =>
  industry ? industryTypes.find((t) => t.value === industry)?.label : undefined;

interface ContextSwitcherSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCreateOrg?: () => void;
  onCreateBusiness?: () => void;
  /**
   * When true, render a "Reporting view" block with a
   * "All Branches (Consolidated)" option above the Branch list. Wired
   * by callers that have a consolidated-authorized user via
   * `useScopeSwitcherProps`.
   */
  consolidatedAvailable?: boolean;
  consolidatedActive?: boolean;
  onSetConsolidated?: (v: boolean) => void;
}

/**
 * Odoo-aligned context switcher.
 *
 * Visibility rules (industry-standard):
 *  - Workspace section: shown only when user belongs to ≥ 2 workspaces.
 *  - Company section:   shown when ≥ 1 company exists; switch list only if ≥ 2.
 *                       If 0 companies → render a "Create your first company" CTA.
 *  - Branch section:    shown only when current company has ≥ 2 branches.
 *
 * No "All Companies" / "All Branches" pseudo-options — multi-entity posting is
 * not supported, so showing them is misleading (Odoo never does this).
 */
export function ContextSwitcherSheet({
  open,
  onOpenChange,
  onCreateOrg,
  onCreateBusiness,
  consolidatedAvailable = false,
  consolidatedActive = false,
  onSetConsolidated,
}: ContextSwitcherSheetProps) {
  const { organizations, currentOrg, switchOrganization } = useOrganization();
  const { businesses, currentBusiness, switchBusiness } = useBusinesses();
  const { branches, currentBranch, switchBranch } = useBranch();
  const permissions = usePermissions();

  const [orgSearch, setOrgSearch] = useState("");
  const [bizSearch, setBizSearch] = useState("");
  const [branchSearch, setBranchSearch] = useState("");

  const showWorkspaceSection = organizations.length >= 2;
  const showCompanyList = businesses.length >= 2;
  const showBranchList = branches.length >= 2;
  const showConsolidatedSection =
    consolidatedAvailable && !!onSetConsolidated && branches.length >= 1;
  // Safety net: if every section is hidden AND no create CTAs are
  // permitted, the sheet would render empty. Surface that explicitly so
  // the user understands their scope is fixed.
  const isCompletelyEmpty =
    !showWorkspaceSection &&
    businesses.length > 0 && !showCompanyList &&
    !showBranchList &&
    !showConsolidatedSection &&
    !permissions.canManageOrganization &&
    !(permissions.canManageBusiness && onCreateBusiness);

  const filteredOrgs = organizations.filter(o =>
    o.name.toLowerCase().includes(orgSearch.toLowerCase())
  );
  const filteredBiz = businesses.filter(b =>
    b.name.toLowerCase().includes(bizSearch.toLowerCase())
  );
  const filteredBranches = branches.filter(b =>
    b.name.toLowerCase().includes(branchSearch.toLowerCase())
  );

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[340px] sm:w-[380px] p-0 flex flex-col">
        <SheetHeader className="px-5 pt-5 pb-3">
          <SheetTitle className="text-base">Switch Context</SheetTitle>
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="px-5 pb-5 space-y-1">
            {isCompletelyEmpty && (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                You're scoped to a single company and branch. There's nothing to switch to.
              </div>
            )}
            {/* Workspace Section — only when ≥ 2 workspaces */}
            {showWorkspaceSection && (
              <>
                <SectionHeader icon={Building} label="Workspace" />
                {organizations.length > 5 && (
                  <SearchInput value={orgSearch} onChange={setOrgSearch} placeholder="Search workspaces..." />
                )}
                <div className="space-y-0.5">
                  {filteredOrgs.map(org => (
                    <SwitcherItem
                      key={org.id}
                      label={org.name}
                      active={currentOrg?.id === org.id}
                      initials={org.name.slice(0, 2).toUpperCase()}
                      onClick={() => {
                        switchOrganization(org.id);
                        onOpenChange(false);
                      }}
                    />
                  ))}
                </div>
                {permissions.canManageOrganization && onCreateOrg && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs text-muted-foreground mt-1"
                    onClick={() => { onCreateOrg(); onOpenChange(false); }}
                  >
                    <Plus className="h-3.5 w-3.5 mr-2" />
                    Create Workspace
                  </Button>
                )}
                <Separator className="!my-3" />
              </>
            )}

            {/* Company Section */}
            <SectionHeader icon={Building2} label="Company" />
            {businesses.length === 0 ? (
              <div className="px-3 py-3 text-xs text-muted-foreground space-y-2">
                <p>This workspace has no company yet. A company holds your books, currency and tax identity.</p>
                {permissions.canManageBusiness && onCreateBusiness && (
                  <Button
                    size="sm"
                    className="w-full"
                    onClick={() => { onCreateBusiness(); onOpenChange(false); }}
                  >
                    <Plus className="h-3.5 w-3.5 mr-2" />
                    Create your first company
                  </Button>
                )}
              </div>
            ) : showCompanyList ? (
              <>
                {businesses.length > 5 && (
                  <SearchInput value={bizSearch} onChange={setBizSearch} placeholder="Search companies..." />
                )}
                <div className="space-y-0.5">
                  {filteredBiz.map(biz => (
                    <SwitcherItem
                      key={biz.id}
                      label={biz.name}
                      subtitle={industryLabel(biz.industry)}
                      active={currentBusiness?.id === biz.id}
                      onClick={() => { switchBusiness(biz.id); onOpenChange(false); }}
                    />
                  ))}
                </div>
                {permissions.canManageBusiness && onCreateBusiness && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs text-muted-foreground mt-1"
                    onClick={() => { onCreateBusiness(); onOpenChange(false); }}
                  >
                    <Plus className="h-3.5 w-3.5 mr-2" />
                    Add Company
                  </Button>
                )}
              </>
            ) : (
              <div className="space-y-0.5">
                {/* Single company — render it as the active item, no switching */}
                <SwitcherItem
                  label={businesses[0].name}
                  subtitle={industryLabel(businesses[0].industry)}
                  active
                  onClick={() => onOpenChange(false)}
                />
                {permissions.canManageBusiness && onCreateBusiness && (
                  <Button
                    variant="ghost"
                    size="sm"
                    className="w-full justify-start text-xs text-muted-foreground mt-1"
                    onClick={() => { onCreateBusiness(); onOpenChange(false); }}
                  >
                    <Plus className="h-3.5 w-3.5 mr-2" />
                    Add another Company
                  </Button>
                )}
              </div>
            )}

            {/* Branch Section — only when current company has ≥ 2 branches */}
            {showBranchList && (
              <>
                <Separator className="!my-3" />
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
                        // Picking a branch always clears consolidated so
                        // the dashboard never silently mixes the two modes.
                        if (consolidatedActive && onSetConsolidated) onSetConsolidated(false);
                        switchBranch(branch.id);
                        onOpenChange(false);
                      }}
                    />
                  ))}
                </div>
              </>
            )}

            {/* Reporting view — consolidated option, when authorized. */}
            {showConsolidatedSection && (
              <>
                <Separator className="!my-3" />
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
