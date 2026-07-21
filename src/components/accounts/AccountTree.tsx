/**
 * AccountTree — VS Code-style hierarchical view of the Chart of Accounts.
 *
 * Renders the 5 canonical account-type roots (Assets, Liabilities, Equity,
 * Income, Expenses) as folder nodes, with recursive nesting of parent →
 * child accounts underneath. Each row exposes:
 *   • chevron toggle (only when the node has children)
 *   • type-appropriate icon
 *   • account code + name (+ system / archived / detail-type badges)
 *   • right-aligned effective balance
 *   • hover-revealed "Add child account" (+) shortcut
 *   • row action menu (register, report, edit, archive/restore, delete)
 *
 * The tree is a pure projection of `accounts[]` — no local caching of
 * business state; expand/collapse is UI state only, persisted per-org
 * in localStorage so the accountant's mental map survives navigation.
 *
 * Search: when a query is active, every node whose code or name matches
 * remains visible along with all its ancestors, and ancestors auto-expand.
 */

import { Fragment, useCallback, useEffect, useMemo, useState } from "react";
import {
  ChevronRight,
  ChevronDown,
  MoreHorizontal,
  Plus,
  Pencil,
  Trash2,
  TrendingUp,
  TrendingDown,
  Wallet,
  CreditCard,
  PiggyBank,
  BookOpen,
  FolderTree,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { Account } from "@/hooks/useAccounts";
import { getDetailTypeLabel } from "@/lib/accountDetailTypes";

type AccountType = Account["account_type"];

interface TypeMeta {
  type: AccountType;
  label: string;
  icon: LucideIcon;
  /** Semantic tint class used for the leading icon of the root folder. */
  iconClass: string;
}

const TYPE_META: TypeMeta[] = [
  { type: "asset", label: "Assets", icon: Wallet, iconClass: "text-sky-600 dark:text-sky-400" },
  { type: "liability", label: "Liabilities", icon: CreditCard, iconClass: "text-rose-600 dark:text-rose-400" },
  { type: "equity", label: "Equity", icon: PiggyBank, iconClass: "text-violet-600 dark:text-violet-400" },
  { type: "income", label: "Income", icon: TrendingUp, iconClass: "text-emerald-600 dark:text-emerald-400" },
  { type: "expense", label: "Expenses", icon: TrendingDown, iconClass: "text-amber-600 dark:text-amber-400" },
];

interface AccountTreeProps {
  accounts: Account[];
  searchQuery: string;
  formatCurrency: (n: number) => string;
  effectiveBalance: (a: Account) => number;
  canEditCoa: boolean;
  onAddChild: (parent: Account) => void;
  onAddRoot: (type: AccountType) => void;
  onEdit: (a: Account) => void;
  onArchive: (a: Account) => void;
  onRestore: (a: Account) => void;
  onDelete: (a: Account) => void;
  onViewRegister: (a: Account) => void;
  onRunReport: (a: Account) => void;
  storageKey?: string;
}

/**
 * Persist expand/collapse state per organisation. Falls back to
 * "expand all 5 type roots" on first paint so the tree isn't empty.
 */
function useExpandedSet(storageKey: string) {
  const [expanded, setExpanded] = useState<Set<string>>(() => {
    if (typeof window === "undefined") return new Set(TYPE_META.map((t) => `type:${t.type}`));
    try {
      const raw = window.localStorage.getItem(storageKey);
      if (raw) return new Set(JSON.parse(raw));
    } catch {
      /* ignore */
    }
    return new Set(TYPE_META.map((t) => `type:${t.type}`));
  });

  useEffect(() => {
    try {
      window.localStorage.setItem(storageKey, JSON.stringify([...expanded]));
    } catch {
      /* ignore */
    }
  }, [expanded, storageKey]);

  const toggle = useCallback((key: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  }, []);

  const expandMany = useCallback((keys: Iterable<string>) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      for (const k of keys) next.add(k);
      return next;
    });
  }, []);

  return { expanded, toggle, expandMany, setExpanded };
}

export function AccountTree(props: AccountTreeProps) {
  const {
    accounts,
    searchQuery,
    formatCurrency,
    effectiveBalance,
    canEditCoa,
    onAddChild,
    onAddRoot,
    onEdit,
    onArchive,
    onRestore,
    onDelete,
    onViewRegister,
    onRunReport,
    storageKey = "coa-tree-expanded",
  } = props;

  const { expanded, toggle, expandMany } = useExpandedSet(storageKey);

  // Index children by parent for O(1) traversal.
  const childrenByParent = useMemo(() => {
    const map = new Map<string | null, Account[]>();
    for (const a of accounts) {
      const key = a.parent_id ?? null;
      const arr = map.get(key);
      if (arr) arr.push(a);
      else map.set(key, [a]);
    }
    for (const arr of map.values()) {
      arr.sort((a, b) => a.code.localeCompare(b.code, undefined, { numeric: true }));
    }
    return map;
  }, [accounts]);

  const parentById = useMemo(() => {
    const map = new Map<string, Account>();
    for (const a of accounts) map.set(a.id, a);
    return map;
  }, [accounts]);

  // Rolled-up balance for a parent = its own effective balance + all descendants.
  const rolledBalance = useMemo(() => {
    const memo = new Map<string, number>();
    const compute = (a: Account): number => {
      const cached = memo.get(a.id);
      if (cached !== undefined) return cached;
      let total = effectiveBalance(a);
      const kids = childrenByParent.get(a.id) ?? [];
      for (const k of kids) total += compute(k);
      memo.set(a.id, total);
      return total;
    };
    for (const a of accounts) compute(a);
    return memo;
  }, [accounts, childrenByParent, effectiveBalance]);

  // Search: compute the set of visible node ids + ancestors to auto-expand.
  const query = searchQuery.trim().toLowerCase();
  const { visibleIds, forcedExpand } = useMemo(() => {
    if (!query) return { visibleIds: null as Set<string> | null, forcedExpand: new Set<string>() };
    const matches = new Set<string>();
    const forced = new Set<string>();
    for (const a of accounts) {
      if (a.code.toLowerCase().includes(query) || a.name.toLowerCase().includes(query)) {
        matches.add(a.id);
        // Force the type root open so matches under any type are reachable.
        forced.add(`type:${a.account_type}`);
        let p = a.parent_id ? parentById.get(a.parent_id) : undefined;
        while (p) {
          matches.add(p.id);
          forced.add(p.id);
          p = p.parent_id ? parentById.get(p.parent_id) : undefined;
        }
      }
    }
    return { visibleIds: matches, forcedExpand: forced };
  }, [query, accounts, parentById]);

  useEffect(() => {
    if (forcedExpand.size > 0) expandMany(forcedExpand);
  }, [forcedExpand, expandMany]);

  const isExpanded = (key: string) => expanded.has(key) || forcedExpand.has(key);

  return (
    <TooltipProvider delayDuration={250}>
      <div
        role="tree"
        aria-label="Chart of accounts"
        className="rounded-md border bg-card overflow-hidden"
      >
        {/* Column header — echoes VS Code's file/size split. */}
        <div className="flex items-center gap-2 px-3 py-2 border-b bg-muted/40 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          <FolderTree className="h-3.5 w-3.5" />
          <span className="flex-1">Account</span>
          <span className="w-32 text-right">Balance</span>
          <span className="w-8" />
        </div>

        {TYPE_META.map((meta) => {
          const roots = (childrenByParent.get(null) ?? []).filter(
            (a) => a.account_type === meta.type,
          );
          const typeKey = `type:${meta.type}`;
          const typeOpen = isExpanded(typeKey);

          // If searching, hide the entire type block when nothing under it matches.
          if (visibleIds) {
            const anyMatch = roots.some((r) => hasVisibleDescendant(r, visibleIds, childrenByParent));
            if (!anyMatch) return null;
          }

          const typeTotal = roots.reduce((sum, r) => sum + (rolledBalance.get(r.id) ?? 0), 0);

          return (
            <div key={meta.type} role="group" className="border-b last:border-b-0">
              <TreeRow
                depth={0}
                hasChildren={roots.length > 0}
                expanded={typeOpen}
                onToggle={() => toggle(typeKey)}
                icon={<meta.icon className={cn("h-4 w-4", meta.iconClass)} />}
                title={meta.label}
                subtitle={`${roots.length} top-level`}
                right={<span className="tabular-nums text-muted-foreground">{formatCurrency(typeTotal)}</span>}
                bold
                actions={
                  canEditCoa ? (
                    <Tooltip>
                      <TooltipTrigger asChild>
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                          onClick={(e) => {
                            e.stopPropagation();
                            onAddRoot(meta.type);
                          }}
                          aria-label={`Add ${meta.label.toLowerCase()} account`}
                        >
                          <Plus className="h-4 w-4" />
                        </Button>
                      </TooltipTrigger>
                      <TooltipContent side="left">New {meta.label.slice(0, -1).toLowerCase()} account</TooltipContent>
                    </Tooltip>
                  ) : null
                }
              />
              {typeOpen && (
                <div role="group">
                  {roots.length === 0 ? (
                    <div className="pl-10 pr-3 py-3 text-xs text-muted-foreground italic">
                      No {meta.label.toLowerCase()} yet.
                      {canEditCoa && (
                        <Button
                          variant="link"
                          size="sm"
                          className="h-auto px-1 py-0 text-xs"
                          onClick={() => onAddRoot(meta.type)}
                        >
                          Create the first one
                        </Button>
                      )}
                    </div>
                  ) : (
                    roots.map((root) => (
                      <AccountNode
                        key={root.id}
                        account={root}
                        depth={1}
                        childrenByParent={childrenByParent}
                        rolledBalance={rolledBalance}
                        expanded={expanded}
                        forcedExpand={forcedExpand}
                        onToggle={toggle}
                        visibleIds={visibleIds}
                        formatCurrency={formatCurrency}
                        effectiveBalance={effectiveBalance}
                        canEditCoa={canEditCoa}
                        onAddChild={onAddChild}
                        onEdit={onEdit}
                        onArchive={onArchive}
                        onRestore={onRestore}
                        onDelete={onDelete}
                        onViewRegister={onViewRegister}
                        onRunReport={onRunReport}
                      />
                    ))
                  )}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </TooltipProvider>
  );
}

/* --------------------------------- Node --------------------------------- */

interface AccountNodeProps {
  account: Account;
  depth: number;
  childrenByParent: Map<string | null, Account[]>;
  rolledBalance: Map<string, number>;
  expanded: Set<string>;
  forcedExpand: Set<string>;
  onToggle: (key: string) => void;
  visibleIds: Set<string> | null;
  formatCurrency: (n: number) => string;
  effectiveBalance: (a: Account) => number;
  canEditCoa: boolean;
  onAddChild: (parent: Account) => void;
  onEdit: (a: Account) => void;
  onArchive: (a: Account) => void;
  onRestore: (a: Account) => void;
  onDelete: (a: Account) => void;
  onViewRegister: (a: Account) => void;
  onRunReport: (a: Account) => void;
}

function AccountNode(props: AccountNodeProps) {
  const {
    account,
    depth,
    childrenByParent,
    rolledBalance,
    expanded,
    forcedExpand,
    onToggle,
    visibleIds,
    formatCurrency,
    effectiveBalance,
    canEditCoa,
    onAddChild,
    onEdit,
    onArchive,
    onRestore,
    onDelete,
    onViewRegister,
    onRunReport,
  } = props;

  if (visibleIds && !visibleIds.has(account.id)) return null;

  const kids = childrenByParent.get(account.id) ?? [];
  const hasKids = kids.length > 0;
  const open = expanded.has(account.id) || forcedExpand.has(account.id);

  const ownBalance = effectiveBalance(account);
  const rolled = rolledBalance.get(account.id) ?? ownBalance;
  const showRolled = hasKids && rolled !== ownBalance;

  return (
    <Fragment>
      <TreeRow
        depth={depth}
        hasChildren={hasKids}
        expanded={open}
        onToggle={() => onToggle(account.id)}
        icon={<BookOpen className={cn("h-3.5 w-3.5", hasKids ? "text-primary" : "text-muted-foreground")} />}
        title={
          <span className="flex min-w-0 items-center gap-2">
            <span className="font-mono text-xs text-muted-foreground">{account.code}</span>
            <span className={cn("truncate", !account.is_active && "text-muted-foreground line-through")}>
              {account.name}
            </span>
            {account.is_system && (
              <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal">
                System
              </Badge>
            )}
            {!account.is_active && (
              <Badge variant="secondary" className="h-4 px-1 text-[10px] font-normal">
                Archived
              </Badge>
            )}
            {account.detail_type && (
              <Badge variant="outline" className="h-4 px-1 text-[10px] font-normal text-muted-foreground">
                {getDetailTypeLabel(account.account_type, account.detail_type)}
              </Badge>
            )}
          </span>
        }
        right={
          <span className="flex flex-col items-end tabular-nums leading-tight">
            <span className={cn(hasKids && "font-semibold")}>{formatCurrency(showRolled ? rolled : ownBalance)}</span>
            {showRolled && (
              <span className="text-[10px] text-muted-foreground">own {formatCurrency(ownBalance)}</span>
            )}
          </span>
        }
        actions={
          <div className="flex items-center gap-0.5">
            {canEditCoa && (
              <Tooltip>
                <TooltipTrigger asChild>
                  <Button
                    variant="ghost"
                    size="icon"
                    className="h-7 w-7 opacity-0 group-hover:opacity-100 focus-visible:opacity-100"
                    onClick={(e) => {
                      e.stopPropagation();
                      onAddChild(account);
                    }}
                    aria-label={`Add sub-account under ${account.name}`}
                  >
                    <Plus className="h-3.5 w-3.5" />
                  </Button>
                </TooltipTrigger>
                <TooltipContent side="left">Add sub-account</TooltipContent>
              </Tooltip>
            )}
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-7 w-7 opacity-60 group-hover:opacity-100"
                  onClick={(e) => e.stopPropagation()}
                  aria-label="Row actions"
                >
                  <MoreHorizontal className="h-4 w-4" />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onClick={() => onViewRegister(account)}>
                  <BookOpen className="mr-2 h-4 w-4" /> View register
                </DropdownMenuItem>
                <DropdownMenuItem onClick={() => onRunReport(account)}>
                  <TrendingUp className="mr-2 h-4 w-4" /> Run report
                </DropdownMenuItem>
                {canEditCoa && (
                  <DropdownMenuItem onClick={() => onAddChild(account)}>
                    <Plus className="mr-2 h-4 w-4" /> Add sub-account
                  </DropdownMenuItem>
                )}
                {canEditCoa && (
                  <DropdownMenuItem onClick={() => onEdit(account)}>
                    <Pencil className="mr-2 h-4 w-4" /> Edit
                  </DropdownMenuItem>
                )}
                {canEditCoa && !account.is_system && account.is_active && (
                  <DropdownMenuItem onClick={() => onArchive(account)}>Make inactive</DropdownMenuItem>
                )}
                {canEditCoa && !account.is_system && !account.is_active && (
                  <DropdownMenuItem onClick={() => onRestore(account)}>Make active</DropdownMenuItem>
                )}
                {canEditCoa && !account.is_system && (
                  <DropdownMenuItem
                    onClick={() => onDelete(account)}
                    className="text-destructive focus:text-destructive"
                  >
                    <Trash2 className="mr-2 h-4 w-4" /> Delete
                  </DropdownMenuItem>
                )}
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        }
      />
      {open && hasKids && (
        <div role="group">
          {kids.map((child) => (
            <AccountNode
              key={child.id}
              {...props}
              account={child}
              depth={depth + 1}
            />
          ))}
        </div>
      )}
    </Fragment>
  );
}

/* ---------------------------------- Row --------------------------------- */

interface TreeRowProps {
  depth: number;
  hasChildren: boolean;
  expanded: boolean;
  onToggle: () => void;
  icon: React.ReactNode;
  title: React.ReactNode;
  subtitle?: React.ReactNode;
  right: React.ReactNode;
  actions?: React.ReactNode;
  bold?: boolean;
}

function TreeRow({
  depth,
  hasChildren,
  expanded,
  onToggle,
  icon,
  title,
  subtitle,
  right,
  actions,
  bold,
}: TreeRowProps) {
  return (
    <div
      role="treeitem"
      aria-expanded={hasChildren ? expanded : undefined}
      onClick={hasChildren ? onToggle : undefined}
      className={cn(
        "group relative flex items-center gap-2 pr-2 py-1.5 text-sm select-none",
        hasChildren && "cursor-pointer",
        "hover:bg-accent/50",
      )}
      style={{ paddingLeft: `${depth * 16 + 8}px` }}
    >
      {/* Indent guides */}
      {Array.from({ length: depth }).map((_, i) => (
        <span
          key={i}
          aria-hidden
          className="absolute top-0 bottom-0 w-px bg-border/60"
          style={{ left: `${i * 16 + 14}px` }}
        />
      ))}

      <span className="flex h-4 w-4 items-center justify-center shrink-0">
        {hasChildren ? (
          expanded ? (
            <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
          ) : (
            <ChevronRight className="h-3.5 w-3.5 text-muted-foreground" />
          )
        ) : (
          <span className="h-3.5 w-3.5" />
        )}
      </span>
      <span className="flex h-4 w-4 items-center justify-center shrink-0">{icon}</span>
      <div className={cn("flex-1 min-w-0 flex items-baseline gap-2", bold && "font-semibold")}>
        <span className="truncate">{title}</span>
        {subtitle && <span className="text-xs text-muted-foreground shrink-0">{subtitle}</span>}
      </div>
      <div className="w-32 text-right text-sm shrink-0">{right}</div>
      <div className="w-8 flex justify-end shrink-0">{actions}</div>
    </div>
  );
}

/* -------------------------------- Helpers ------------------------------- */

function hasVisibleDescendant(
  node: Account,
  visible: Set<string>,
  childrenByParent: Map<string | null, Account[]>,
): boolean {
  if (visible.has(node.id)) return true;
  const kids = childrenByParent.get(node.id) ?? [];
  return kids.some((k) => hasVisibleDescendant(k, visible, childrenByParent));
}
