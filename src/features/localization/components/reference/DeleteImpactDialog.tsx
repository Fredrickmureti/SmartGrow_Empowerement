/**
 * Shared destructive-confirm dialog for reference editors.
 *
 * - Runs `analyzeReferenceDelete` on open.
 * - When dependents are found: lists them, requires the user to type the
 *   row's primary key to enable Delete.
 * - When clean: renders a one-line "no dependents" note and Delete is enabled
 *   immediately.
 */
import { useEffect, useState } from "react";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Loader2, AlertTriangle, ShieldCheck } from "lucide-react";
import { analyzeReferenceDelete, type ImpactResult, type ReferenceKind } from "../../lib/tokenImpact";

interface Props {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  packId: string;
  kind: ReferenceKind;
  rowKey: string;
  rowLabel: string;
  onConfirm: () => void;
  pending?: boolean;
}

export function DeleteImpactDialog({
  open, onOpenChange, packId, kind, rowKey, rowLabel, onConfirm, pending,
}: Props) {
  const [impact, setImpact] = useState<ImpactResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [confirmText, setConfirmText] = useState("");

  useEffect(() => {
    if (!open) { setImpact(null); setConfirmText(""); return; }
    let cancelled = false;
    setLoading(true);
    analyzeReferenceDelete({ packId, kind, key: rowKey })
      .then((r) => { if (!cancelled) setImpact(r); })
      .finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [open, packId, kind, rowKey]);

  const dependentsFound = !!impact && !impact.empty;
  const canDelete = !loading && (!dependentsFound || confirmText.trim() === rowKey);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg">
        <DialogHeader>
          <DialogTitle>Delete {rowLabel}?</DialogTitle>
        </DialogHeader>

        {loading && (
          <div className="text-sm text-muted-foreground flex items-center gap-2">
            <Loader2 className="h-4 w-4 animate-spin" /> Checking dependent tokens and templates…
          </div>
        )}

        {!loading && impact?.empty && (
          <Alert>
            <ShieldCheck className="h-4 w-4" />
            <AlertDescription className="text-xs">
              No dependent tokens or templates found in this pack. Safe to delete.
            </AlertDescription>
          </Alert>
        )}

        {!loading && dependentsFound && (
          <div className="space-y-3">
            <Alert variant="destructive">
              <AlertTriangle className="h-4 w-4" />
              <AlertDescription className="text-xs">
                <strong>{rowKey}</strong> is referenced by {impact!.tokens.length} token
                {impact!.tokens.length === 1 ? "" : "s"} and {impact!.templates.length} template
                {impact!.templates.length === 1 ? "" : "s"}. Deleting it will break their rendering until they are updated.
              </AlertDescription>
            </Alert>

            {impact!.tokens.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium">Tokens</div>
                <ul className="text-xs text-muted-foreground space-y-0.5 max-h-28 overflow-auto border rounded-md p-2">
                  {impact!.tokens.map((t) => (
                    <li key={t.id} className="font-mono">{t.token_path}</li>
                  ))}
                </ul>
              </div>
            )}

            {impact!.templates.length > 0 && (
              <div className="space-y-1">
                <div className="text-xs font-medium">Templates</div>
                <ul className="text-xs text-muted-foreground space-y-1 max-h-32 overflow-auto border rounded-md p-2">
                  {impact!.templates.map((tpl, i) => (
                    <li key={`${tpl.table}-${tpl.code}-${i}`}>
                      <span className="font-medium">{tpl.code}</span>
                      {tpl.display_name && <span className="text-muted-foreground"> — {tpl.display_name}</span>}
                      <span className="text-muted-foreground"> · {tpl.table.includes("certificate") ? "certificate" : "return"}</span>
                      <div className="font-mono text-[10px] truncate">via {tpl.matchedTokens.join(", ")}</div>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="space-y-1">
              <div className="text-xs">Type <code className="px-1 bg-muted rounded">{rowKey}</code> to confirm.</div>
              <Input
                value={confirmText}
                onChange={(e) => setConfirmText(e.target.value)}
                placeholder={rowKey}
                autoFocus
              />
            </div>
          </div>
        )}

        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button variant="destructive" onClick={onConfirm} disabled={!canDelete || pending}>
            {pending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}Delete
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
