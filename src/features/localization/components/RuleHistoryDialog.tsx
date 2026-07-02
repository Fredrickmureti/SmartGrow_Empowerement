/**
 * RuleHistoryDialog — vertical timeline of how a single rule has evolved
 * across published pack versions. Reads `pack_versions.snapshot` (already
 * fetched by `usePackVersions`) and renders compact `<PackDiffView>`
 * panels between consecutive snapshots so users can see exactly *what*
 * changed at every version bump.
 *
 * Read-only. No mutations. Safe to mount in both admin and tenant modes.
 */
import { useMemo } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Badge } from "@/components/ui/badge";
import { Loader2, Clock } from "lucide-react";
import { usePackVersions } from "../hooks/usePack";
import { PackDiffView } from "./PackDiffView";
import { traverseRuleHistory, type RuleHistoryEntry } from "../lib/ruleHistory";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packId: string;
  ruleCode: string;
  ruleName?: string;
}

function fmtDate(s?: string | null) {
  if (!s) return "—";
  try { return new Date(s).toISOString().slice(0, 10); } catch { return s; }
}

export function RuleHistoryDialog({ open, onOpenChange, packId, ruleCode, ruleName }: Props) {
  const { data: versions, isLoading } = usePackVersions(open ? packId : null);

  const history = useMemo<RuleHistoryEntry[]>(
    () => traverseRuleHistory(versions ?? [], ruleCode),
    [versions, ruleCode],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2 text-base">
            <Clock className="h-4 w-4" />
            History — <span className="font-mono">{ruleName ?? ruleCode}</span>
          </DialogTitle>
        </DialogHeader>

        {isLoading && (
          <div className="flex items-center gap-2 text-sm text-muted-foreground py-6">
            <Loader2 className="h-4 w-4 animate-spin" />Loading versions…
          </div>
        )}

        {!isLoading && history.length === 0 && (
          <div className="text-sm text-muted-foreground py-6">
            No published version history for this rule yet. Once the pack is published,
            each version's snapshot of <code>{ruleCode}</code> will appear here.
          </div>
        )}

        {!isLoading && history.length > 0 && (
          <div className="space-y-4">
            {history.map((entry, i) => {
              const prev = i > 0 ? history[i - 1] : null;
              return (
                <div key={entry.version_id} className="relative pl-5 border-l-2 border-muted">
                  <div className="absolute -left-[7px] top-1 h-3 w-3 rounded-full bg-primary" />
                  <div className="flex items-center gap-2 flex-wrap">
                    <Badge variant="secondary" className="font-mono">v{entry.version}</Badge>
                    {entry.rule_type && (
                      <Badge variant="outline" className="text-[10px]">{entry.rule_type}</Badge>
                    )}
                    <span className="text-xs text-muted-foreground">
                      published {fmtDate(entry.published_at)}
                    </span>
                    {(entry.effective_from || entry.effective_to) && (
                      <span className="text-xs text-muted-foreground">
                        · effective {fmtDate(entry.effective_from)} → {fmtDate(entry.effective_to)}
                      </span>
                    )}
                  </div>
                  {entry.description && (
                    <div className="text-xs text-muted-foreground mt-1">{entry.description}</div>
                  )}
                  <div className="mt-2">
                    {prev ? (
                      <PackDiffView
                        previous={{ rule: [{ rule_code: ruleCode, parameters: prev.parameters }] }}
                        next={{ rule: [{ rule_code: ruleCode, parameters: entry.parameters }] }}
                        title={`Changes from v${prev.version} → v${entry.version}`}
                      />
                    ) : (
                      <div className="text-xs text-muted-foreground italic">
                        Initial version — baseline parameters captured.
                      </div>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}