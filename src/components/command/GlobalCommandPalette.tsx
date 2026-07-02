/**
 * GlobalCommandPalette
 *
 * UI surface for the unified command system. Renders results from
 * `useCommandPalette()` grouped by kind, with full keyboard navigation
 * provided by `cmdk` (already used elsewhere in the app).
 *
 * Visual rules:
 *   - icon · title · subtitle (muted) · kind badge (right)
 *   - groups in order: Pinned / Recent / Suggested / Frequent (empty)
 *   - Pages / Actions / Reports / Modules / Records (active query)
 *   - record-search results from async providers append below
 *   - Cmd/Ctrl+K hint shown at the bottom
 *
 * This component owns NO data. All ranking/filtering/permissions live
 * in the hook — the UI is pure presentation.
 */

import { useEffect, useMemo } from "react";
import { Pin, PinOff, Sparkles, ArrowRight, X } from "lucide-react";
import {
  CommandDialog, CommandEmpty, CommandGroup, CommandInput,
  CommandItem, CommandList, CommandSeparator,
} from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useCommandPaletteContext } from "@/providers/CommandPaletteProvider";
import { APP_REGISTRY } from "@/lib/apps/registry";
import type { CommandEntry, CommandKind } from "@/lib/command/types";

const KIND_ORDER: CommandKind[] = ["page", "action", "report", "module", "record"];
const KIND_LABEL: Record<CommandKind, string> = {
  page: "Pages",
  action: "Actions",
  report: "Reports",
  module: "Apps",
  record: "Records",
};
const KIND_BADGE: Record<CommandKind, string> = {
  page: "Page",
  action: "Action",
  report: "Report",
  module: "App",
  record: "Record",
};

function CommandRow({
  entry,
  onSelect,
  pinned,
  onTogglePin,
  switchToAppName,
}: {
  entry: CommandEntry;
  onSelect: () => void;
  pinned: boolean;
  onTogglePin: () => void;
  /** When set, renders a "→ <app>" chip indicating cross-module navigation. */
  switchToAppName?: string | null;
}) {
  const Icon = entry.icon;
  return (
    <CommandItem
      // Use the entry id as `value` so cmdk's own internal filter doesn't
      // re-filter on top of ours — we already feed it the right list.
      value={entry.id}
      onSelect={onSelect}
      className="flex items-center gap-3 py-2.5 group"
    >
      <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium truncate">{entry.title}</div>
        {entry.subtitle && (
          <div className="text-xs text-muted-foreground truncate">{entry.subtitle}</div>
        )}
      </div>
      {switchToAppName && (
        <span
          className="hidden md:inline-flex items-center gap-1 text-[10px] text-muted-foreground shrink-0 rounded border border-dashed px-1.5 py-0.5"
          title={`Switches to ${switchToAppName}`}
        >
          <ArrowRight className="h-2.5 w-2.5" />
          {switchToAppName}
        </span>
      )}
      <Button
        variant="ghost"
        size="icon"
        className="h-6 w-6 opacity-0 group-hover:opacity-100 data-[pinned=true]:opacity-100"
        data-pinned={pinned}
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onTogglePin();
        }}
        aria-label={pinned ? "Unpin" : "Pin"}
      >
        {pinned ? <PinOff className="h-3 w-3" /> : <Pin className="h-3 w-3" />}
      </Button>
      <Badge variant="outline" className="text-[10px] shrink-0 font-normal">
        {KIND_BADGE[entry.kind]}
      </Badge>
    </CommandItem>
  );
}

export function GlobalCommandPalette() {
  const {
    open, setOpen, query, setQuery,
    results, providerGroups, providersLoading,
    empty, marketplace, run, isPinned, togglePin,
    parsed, currentAppId, activeSurface,
  } = useCommandPaletteContext();

  // ── App-name lookup for "switch to app" hints ─────────────────────
  // Only rendered when an entry's appId differs from currentAppId.
  const appNameById = useMemo(() => {
    const m = new Map<string, string>();
    for (const a of APP_REGISTRY) m.set(a.id, a.name);
    return m;
  }, []);
  const switchAppName = (appId?: string | null): string | null => {
    if (!appId || !currentAppId || appId === currentAppId) return null;
    return appNameById.get(appId) ?? null;
  };

  // ── Active scope chip label (drives discoverability of `>` / `#` / `inv …`) ──
  const scopeChip = useMemo(() => {
    if (parsed.kindScope === "action") return { label: "Actions", title: "Filtering to actions (>)" };
    if (parsed.providerScope) {
      // Friendly label from the provider id, e.g. "records:invoices" → "Invoices".
      const tail = parsed.providerScope.split(":").pop() ?? parsed.providerScope;
      const friendly = tail.charAt(0).toUpperCase() + tail.slice(1).replace(/-/g, " ");
      return { label: friendly, title: `Filtering to ${friendly}` };
    }
    if (parsed.kindScope === "record") return { label: "Records", title: "Filtering to records (#)" };
    return null;
  }, [parsed]);

  const clearScope = () => setQuery(parsed.text);


  // ⌘P → pin/unpin currently highlighted entry.
  // We read the active row from cmdk's `aria-selected="true"` attribute
  // ON DEMAND inside the keydown handler — no MutationObserver needed.
  // This eliminates the per-keystroke observer callback that previously
  // fired on every ↑/↓ navigation.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "p") {
        const list = document.querySelector<HTMLElement>("[cmdk-list]");
        const sel = list?.querySelector<HTMLElement>(
          "[cmdk-item][aria-selected='true'], [data-selected='true']",
        );
        const id = sel?.getAttribute("data-value");
        if (id) {
          e.preventDefault();
          togglePin(id);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, togglePin]);

  // Group ranked results by kind, preserving rank order within each group.
  const grouped = useMemo(() => {
    const map = new Map<CommandKind, CommandEntry[]>();
    for (const r of results) {
      const arr = map.get(r.entry.kind) ?? [];
      arr.push(r.entry);
      map.set(r.entry.kind, arr);
    }
    return map;
  }, [results]);

  const hasQuery = query.trim().length > 0;

  return (
    <CommandDialog
      open={open}
      onOpenChange={(v) => { setOpen(v); if (!v) setQuery(""); }}
    >
      <CommandInput
        placeholder={
          activeSurface === "platform"
            ? "Search admin pages…"
            : "Search pages, actions, reports, customers…"
        }
        value={query}
        onValueChange={setQuery}
      />
      {(scopeChip || activeSurface === "platform") && (
        <div className="flex items-center gap-2 border-b px-3 py-1.5">
          {activeSurface === "platform" && (
            <Badge
              variant="outline"
              className="gap-1 px-2 py-0.5 text-[11px] font-normal border-amber-500/40 text-amber-700 dark:text-amber-400"
              title="You're in the Platform Admin console — tenant pages are hidden"
            >
              Platform Admin
            </Badge>
          )}
          {scopeChip && (
            <>
              <span className="text-[10px] uppercase tracking-wide text-muted-foreground">Scope</span>
              <Badge
                variant="secondary"
                className="gap-1 pl-2 pr-1 py-0.5 text-[11px] font-normal"
                title={scopeChip.title}
              >
                {scopeChip.label}
                <button
                  type="button"
                  onClick={clearScope}
                  className="ml-0.5 rounded-sm hover:bg-muted-foreground/20 p-0.5"
                  aria-label="Clear scope"
                >
                  <X className="h-3 w-3" />
                </button>
              </Badge>
            </>
          )}
        </div>
      )}
      <CommandList className="max-h-[420px]">
        <CommandEmpty>
          {providersLoading ? "Searching…" : `No matches for "${query}"`}
        </CommandEmpty>

        {/* ── Discoverability hint (empty query, no scope) ───────────── */}
        {!hasQuery && !scopeChip && (
          <div className="px-3 pt-2 pb-1 text-[11px] text-muted-foreground flex flex-wrap items-center gap-x-3 gap-y-1">
            <span>Try</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">&gt;invoice</code>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">#1042</code>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">inv 1042</code>
            <span>·</span>
            <code className="rounded bg-muted px-1.5 py-0.5 font-mono text-[10px]">?</code>
            <span>for help</span>
          </div>
        )}

        {/* ── Empty state ────────────────────────────────────────────── */}
        {!hasQuery && (
          <>
            {empty.pinned.length > 0 && (
              <CommandGroup heading="Pinned">
                {empty.pinned.map((e) => (
                  <CommandRow
                    key={`p-${e.id}`}
                    entry={e}
                    onSelect={() => run(e)}
                    pinned
                    onTogglePin={() => togglePin(e.id)}
                  switchToAppName={switchAppName(e.appId)}
                  />
                ))}
              </CommandGroup>
            )}
            {empty.recent.length > 0 && (
              <>
                {empty.pinned.length > 0 && <CommandSeparator />}
                <CommandGroup heading="Recent">
                  {empty.recent.map((e) => (
                    <CommandRow
                      key={`r-${e.id}`}
                      entry={e}
                      onSelect={() => run(e)}
                      pinned={isPinned(e.id)}
                      onTogglePin={() => togglePin(e.id)}
                    switchToAppName={switchAppName(e.appId)}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
            {empty.suggested.length > 0 && (
              <>
                {(empty.pinned.length > 0 || empty.recent.length > 0) && <CommandSeparator />}
                <CommandGroup heading="Suggested">
                  {empty.suggested.map((e) => (
                    <CommandRow
                      key={`s-${e.id}`}
                      entry={e}
                      onSelect={() => run(e)}
                      pinned={isPinned(e.id)}
                      onTogglePin={() => togglePin(e.id)}
                    switchToAppName={switchAppName(e.appId)}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
            {empty.frequent.length > 0 && (
              <>
                <CommandSeparator />
                <CommandGroup heading="Frequent">
                  {empty.frequent.map((e) => (
                    <CommandRow
                      key={`f-${e.id}`}
                      entry={e}
                      onSelect={() => run(e)}
                      pinned={isPinned(e.id)}
                      onTogglePin={() => togglePin(e.id)}
                    switchToAppName={switchAppName(e.appId)}
                    />
                  ))}
                </CommandGroup>
              </>
            )}
          </>
        )}

        {/* ── Active query: static results ───────────────────────────── */}
        {hasQuery && KIND_ORDER.map((kind, i) => {
          const items = grouped.get(kind);
          if (!items || items.length === 0) return null;
          return (
            <div key={kind}>
              {i > 0 && <CommandSeparator />}
              <CommandGroup heading={KIND_LABEL[kind]}>
                {items.map((e) => (
                  <CommandRow
                    key={e.id}
                    entry={e}
                    onSelect={() => run(e)}
                    pinned={isPinned(e.id)}
                    onTogglePin={() => togglePin(e.id)}
                  switchToAppName={switchAppName(e.appId)}
                  />
                ))}
              </CommandGroup>
            </div>
          );
        })}

        {/* ── Active query: async provider results ───────────────────── */}
        {hasQuery && providerGroups.map((g) => (
          <div key={g.provider.id}>
            <CommandSeparator />
            <CommandGroup heading={g.provider.label}>
              {g.entries.map((e) => (
                <CommandRow
                  key={e.id}
                  entry={e}
                  onSelect={() => run(e)}
                  pinned={isPinned(e.id)}
                  onTogglePin={() => togglePin(e.id)}
                switchToAppName={switchAppName(e.appId)}
                />
              ))}
            </CommandGroup>
          </div>
        ))}

        {/* ── Marketplace fallback: matched but app not installed ────── */}
        {hasQuery && marketplace.length > 0 && (
          <>
            <CommandSeparator />
            <CommandGroup heading="Available in Marketplace">
              {marketplace.map((m) => {
                // Synthesise an entry so existing run() does the navigation.
                const synth: CommandEntry = {
                  id: `marketplace:${m.appId}`,
                  kind: "module",
                  title: `Activate ${m.appName}`,
                  subtitle: `Matched “${m.entry.title}” — install to enable`,
                  appId: m.appId,
                  icon: m.entry.icon,
                  keywords: [],
                  to: `/apps/${m.appId}/activate`,
                };
                return (
                  <CommandItem
                    key={synth.id}
                    value={synth.id}
                    onSelect={() => run(synth)}
                    className="flex items-center gap-3 py-2.5"
                  >
                    <Sparkles className="h-4 w-4 text-muted-foreground shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm font-medium truncate">{synth.title}</div>
                      <div className="text-xs text-muted-foreground truncate">{synth.subtitle}</div>
                    </div>
                    <Badge variant="secondary" className="text-[10px] shrink-0 font-normal gap-1">
                      Marketplace
                      <ArrowRight className="h-3 w-3" />
                    </Badge>
                  </CommandItem>
                );
              })}
            </CommandGroup>
          </>
        )}
      </CommandList>

      <div className="flex items-center justify-between border-t px-3 py-2 text-[11px] text-muted-foreground">
        <span>↑↓ navigate · ⏎ open · ⌘P pin · esc close</span>
        <span>
          <kbd className="rounded border bg-muted px-1.5 py-0.5 font-mono text-[10px]">⌘K</kbd>
        </span>
      </div>
    </CommandDialog>
  );
}
