/**
 * PackDiffView — JSON-path level diff of two pack-version snapshots.
 *
 * The `publish-localization-pack-version` edge function stores the full
 * snapshot of all pack child tables on `pack_versions.snapshot`. This
 * component takes two snapshots (previous + current) and renders a
 * compact, table-grouped, field-level diff. It is used by:
 *   - admin: draft preview vs prior published version
 *   - tenant: upstream pack vs locally-overridden pack
 */
import { useMemo } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ArrowRight, Plus, Minus, Pencil } from "lucide-react";

type Snap = Record<string, any[]> | null | undefined;

interface DiffRow {
  table: string;
  key: string;
  kind: "added" | "removed" | "modified";
  changes?: Array<{ path: string; before: unknown; after: unknown }>;
}

function rowKey(table: string, row: any): string {
  // Best-effort stable key: prefer rule_code / template_code / id.
  return row?.rule_code ?? row?.template_code ?? row?.code ?? row?.id ?? JSON.stringify(row);
}

function diffObjects(a: any, b: any, prefix = ""): Array<{ path: string; before: unknown; after: unknown }> {
  const out: Array<{ path: string; before: unknown; after: unknown }> = [];
  const keys = new Set([...Object.keys(a ?? {}), ...Object.keys(b ?? {})]);
  for (const k of keys) {
    if (["created_at", "updated_at", "id"].includes(k)) continue;
    const av = a?.[k];
    const bv = b?.[k];
    const path = prefix ? `${prefix}.${k}` : k;
    if (av && bv && typeof av === "object" && typeof bv === "object" && !Array.isArray(av) && !Array.isArray(bv)) {
      out.push(...diffObjects(av, bv, path));
    } else if (JSON.stringify(av) !== JSON.stringify(bv)) {
      out.push({ path, before: av, after: bv });
    }
  }
  return out;
}

function computeDiff(prev: Snap, next: Snap): DiffRow[] {
  const rows: DiffRow[] = [];
  const tables = new Set([...Object.keys(prev ?? {}), ...Object.keys(next ?? {})]);
  for (const t of tables) {
    const prevRows = prev?.[t] ?? [];
    const nextRows = next?.[t] ?? [];
    const prevMap = new Map(prevRows.map((r: any) => [rowKey(t, r), r]));
    const nextMap = new Map(nextRows.map((r: any) => [rowKey(t, r), r]));
    for (const [k, r] of nextMap) {
      if (!prevMap.has(k)) rows.push({ table: t, key: k, kind: "added" });
      else {
        const changes = diffObjects(prevMap.get(k), r);
        if (changes.length) rows.push({ table: t, key: k, kind: "modified", changes });
      }
    }
    for (const [k] of prevMap) {
      if (!nextMap.has(k)) rows.push({ table: t, key: k, kind: "removed" });
    }
  }
  return rows;
}

export function PackDiffView({
  previous,
  next,
  title = "Diff",
}: {
  previous: Snap;
  next: Snap;
  title?: string;
}) {
  const diff = useMemo(() => computeDiff(previous, next), [previous, next]);
  const grouped = useMemo(() => {
    const m = new Map<string, DiffRow[]>();
    for (const r of diff) {
      const arr = m.get(r.table) ?? [];
      arr.push(r);
      m.set(r.table, arr);
    }
    return Array.from(m.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [diff]);

  if (!diff.length) {
    return (
      <Card>
        <CardHeader><CardTitle className="text-base">{title}</CardTitle></CardHeader>
        <CardContent className="text-sm text-muted-foreground">No differences.</CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base flex items-center gap-2">
          {title}
          <Badge variant="secondary">{diff.length} change{diff.length === 1 ? "" : "s"}</Badge>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {grouped.map(([table, rows]) => (
          <div key={table} className="space-y-1">
            <div className="text-xs font-medium uppercase text-muted-foreground">{table}</div>
            <div className="space-y-2">
              {rows.map((r, i) => (
                <div key={`${r.key}-${i}`} className="border rounded-md p-2 text-sm">
                  <div className="flex items-center gap-2">
                    {r.kind === "added" && <Plus className="h-3.5 w-3.5 text-green-600" />}
                    {r.kind === "removed" && <Minus className="h-3.5 w-3.5 text-red-600" />}
                    {r.kind === "modified" && <Pencil className="h-3.5 w-3.5 text-amber-600" />}
                    <span className="font-mono">{r.key}</span>
                    <Badge variant="outline" className="ml-auto text-[10px]">{r.kind}</Badge>
                  </div>
                  {r.changes?.length ? (
                    <div className="mt-2 space-y-1 pl-5 text-xs">
                      {r.changes.map((c, j) => (
                        <div key={j} className="grid grid-cols-[auto_1fr_auto_1fr] items-start gap-2">
                          <span className="font-mono text-muted-foreground">{c.path}</span>
                          <code className="bg-red-50 dark:bg-red-950 px-1 rounded break-all">
                            {JSON.stringify(c.before)}
                          </code>
                          <ArrowRight className="h-3 w-3 mt-1" />
                          <code className="bg-green-50 dark:bg-green-950 px-1 rounded break-all">
                            {JSON.stringify(c.after)}
                          </code>
                        </div>
                      ))}
                    </div>
                  ) : null}
                </div>
              ))}
            </div>
          </div>
        ))}
      </CardContent>
    </Card>
  );
}

export { computeDiff as __computePackDiff };