/**
 * TemplateFieldInspector — shared side panel that scans every
 * `{{ token.path }}` reference inside a template body and reports
 * whether the token is known to the pack's `pack_token_registry`.
 *
 * Used by both the return-template editor and the new certificate
 * template editor. Turns an editor into a genuine publishing surface:
 * a publisher sees at a glance which tokens will resolve at render
 * time and which will emit `TOKEN_UNRESOLVED` diagnostics.
 *
 * Contract:
 *   - Reads all string values reachable in `body` (block content or
 *     any nested string) and extracts `{{...}}` occurrences.
 *   - Cross-references each with the registry (platform tokens +
 *     pack tokens, same shape returned by `usePackTokens`).
 *   - Emits `onValidityChange({ hasUnresolved, unresolved })` so the
 *     parent editor can block Save when unresolved tokens exist.
 *
 * This is pure UI — the authoritative validation still runs server-side
 * in `_shared/renderTokens` when the template is rendered. This panel
 * just brings that diagnostic surface into the authoring loop.
 */
import { useEffect, useMemo } from "react";
import { AlertTriangle, CheckCircle2, Info } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ScrollArea } from "@/components/ui/scroll-area";
import { usePackTokens } from "../hooks/usePackTokens";

const TOKEN_RE = /\{\{\s*([a-zA-Z_][a-zA-Z0-9_.\[\]]*)\s*(?:\|[^}]*)?\}\}/g;

function collectStrings(node: unknown, out: string[]): void {
  if (node == null) return;
  if (typeof node === "string") {
    out.push(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const item of node) collectStrings(item, out);
    return;
  }
  if (typeof node === "object") {
    for (const v of Object.values(node as Record<string, unknown>)) collectStrings(v, out);
  }
}

function extractTokens(body: unknown): string[] {
  const strings: string[] = [];
  collectStrings(body, strings);
  const found = new Set<string>();
  for (const s of strings) {
    let m: RegExpExecArray | null;
    TOKEN_RE.lastIndex = 0;
    while ((m = TOKEN_RE.exec(s)) !== null) {
      // Normalise trailing array index like foo.bar[0] → foo.bar
      found.add(m[1].replace(/\[\d+\]/g, ""));
    }
  }
  return Array.from(found).sort();
}

interface Props {
  packId?: string | null;
  body: unknown;
  onValidityChange?: (state: { hasUnresolved: boolean; unresolved: string[] }) => void;
}

export function TemplateFieldInspector({ packId, body, onValidityChange }: Props) {
  const tokensQuery = usePackTokens(packId);

  const referenced = useMemo(() => extractTokens(body), [body]);

  const registryPaths = useMemo(() => {
    const set = new Set<string>();
    for (const t of tokensQuery.data ?? []) set.add(t.value);
    return set;
  }, [tokensQuery.data]);

  const { resolved, unresolved } = useMemo(() => {
    const r: string[] = [];
    const u: string[] = [];
    for (const token of referenced) {
      // A token resolves if its full path OR its head segment is in the
      // registry (e.g. `employee.full_name` resolves via `employee.*`).
      const head = token.split(".")[0];
      if (registryPaths.has(token) || Array.from(registryPaths).some((p) => p.startsWith(`${head}.`))) {
        r.push(token);
      } else {
        u.push(token);
      }
    }
    return { resolved: r, unresolved: u };
  }, [referenced, registryPaths]);

  useEffect(() => {
    onValidityChange?.({ hasUnresolved: unresolved.length > 0, unresolved });
  }, [unresolved.join("|")]);

  return (
    <Card>
      <CardHeader className="pb-2">
        <CardTitle className="text-sm flex items-center gap-2">
          <Info className="h-4 w-4" />
          Field inspector
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3 text-xs">
        {tokensQuery.isLoading && (
          <div className="text-muted-foreground">Loading pack token registry…</div>
        )}
        {!tokensQuery.isLoading && referenced.length === 0 && (
          <div className="text-muted-foreground">No tokens referenced in this template yet.</div>
        )}

        {unresolved.length > 0 && (
          <div className="rounded-md border border-destructive/40 bg-destructive/5 p-2 space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-destructive">
              <AlertTriangle className="h-3.5 w-3.5" />
              Unresolved tokens — Save is blocked
            </div>
            <ScrollArea className="max-h-48">
              <ul className="space-y-1">
                {unresolved.map((t) => (
                  <li key={t}>
                    <code className="text-[11px]">{t}</code>{" "}
                    <span className="text-muted-foreground">
                      not found in pack_token_registry
                    </span>
                  </li>
                ))}
              </ul>
            </ScrollArea>
          </div>
        )}

        {resolved.length > 0 && (
          <div className="space-y-1">
            <div className="flex items-center gap-1.5 font-medium text-emerald-600 dark:text-emerald-400">
              <CheckCircle2 className="h-3.5 w-3.5" />
              Resolved ({resolved.length})
            </div>
            <ScrollArea className="max-h-48">
              <div className="flex flex-wrap gap-1">
                {resolved.map((t) => (
                  <Badge key={t} variant="outline" className="font-mono text-[10px]">
                    {t}
                  </Badge>
                ))}
              </div>
            </ScrollArea>
          </div>
        )}
      </CardContent>
    </Card>
  );
}