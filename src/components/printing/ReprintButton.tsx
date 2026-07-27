/**
 * ReprintButton — governed reprint affordance.
 *
 * Wired into every document detail surface that can produce a hardware
 * artefact (invoice, credit note, GRN, delivery note, payslip, POS
 * receipt). Surfaces a dialog that collects a non-empty reason (tax
 * compliance in KE/TZ/UG treats reprints as auditable events) and
 * routes through `requestReprint` → `dispatchLabelReprint` /
 * `dispatchReceiptReprint`.
 *
 * `kind`:
 *   - 'label'   → uses label-template dispatch (GRN labels, shipping
 *                 labels, asset tags) — needs `templateKey` + `workflow`.
 *   - 'receipt' → uses receipt-printer dispatch (POS receipts, payslips,
 *                 invoices) — needs `receiptData`.
 */
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription } from '@/components/ui/dialog';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { Printer, Loader2 } from 'lucide-react';
import { useToast } from '@/hooks/use-toast';
import { useBusinesses } from '@/hooks/useBusinesses';
import { useOrganization } from '@/hooks/useOrganization';
import { requestReprint, dispatchLabelReprint, dispatchReceiptReprint } from '@/services/printing/reprintClient';
import type { PrinterWorkflow } from '@/services/printing/labelDispatch';

type LabelKind = {
  kind: 'label';
  templateKey: string;
  workflow?: PrinterWorkflow;
  vars?: Record<string, string | number | null | undefined>;
};

type ReceiptKind = {
  kind: 'receipt';
  receiptData: unknown;
};

export type ReprintButtonProps = {
  documentKind: string;            // 'invoice' | 'credit_note' | 'grn_label' | 'shipping_label' | 'payslip' | 'pos_receipt' | …
  sourceDocType: string;           // 'invoice' | 'credit_note' | 'goods_receipt' | …
  sourceDocId: string;
  branchId?: string | null;
  warehouseId?: string | null;
  documentNumber?: string;         // shown in the dialog for confirmation
  size?: 'sm' | 'default';
  variant?: 'default' | 'outline' | 'ghost' | 'secondary';
} & (LabelKind | ReceiptKind);

export function ReprintButton(props: ReprintButtonProps) {
  const { currentBusiness } = useBusinesses();
  const { currentOrg } = useOrganization();
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);

  const orgId = currentBusiness?.id;

  async function handleConfirm() {
    if (!orgId) {
      toast({ variant: 'destructive', title: 'No active organization' });
      return;
    }
    if (!reason.trim()) {
      toast({ variant: 'destructive', title: 'Reason required', description: 'Reprints are auditable.' });
      return;
    }
    setBusy(true);
    try {
      const req = await requestReprint({
        orgId,
        branchId: props.branchId ?? null,
        documentKind: props.documentKind,
        sourceDocType: props.sourceDocType,
        sourceDocId: props.sourceDocId,
        reason,
        metadata: { documentNumber: props.documentNumber ?? null },
      });
      if (!req.ok) {
        toast({ variant: 'destructive', title: 'Reprint blocked', description: (req as { ok: false; error: string }).error });
        return;
      }

      if (props.kind === 'label') {
        const res = await dispatchLabelReprint(req.requestId, {
          orgId,
          templateKey: props.templateKey,
          workflow: props.workflow ?? 'generic',
          branchId: props.branchId ?? null,
          warehouseId: props.warehouseId ?? null,
          vars: props.vars ?? { id: props.sourceDocId },
          sourceDocType: props.sourceDocType,
          sourceDocId: props.sourceDocId,
        });
        if (!res?.success) {
          toast({ variant: 'destructive', title: 'Reprint queued but not printed', description: res?.error ?? 'Printer unavailable' });
        } else {
          toast({ title: 'Reprint sent' });
        }
      } else {
        const res = await dispatchReceiptReprint(req.requestId, {
          receiptData: props.receiptData,
          sourceDocType: props.sourceDocType,
          sourceDocId: props.sourceDocId,
          // Phase 5 Step B — the device resolver is org-scoped; pass the
          // real organization plus the active business tie-break.
          organizationId: currentOrg?.id ?? '',
          businessId: currentBusiness?.id ?? null,
        });
        if (!res?.success) {
          toast({ variant: 'destructive', title: 'Reprint queued but not printed', description: res?.error ?? 'Printer unavailable' });
        } else {
          toast({ title: 'Reprint sent' });
        }
      }

      setOpen(false);
      setReason('');
    } catch (e) {
      toast({ variant: 'destructive', title: 'Reprint failed', description: e instanceof Error ? e.message : String(e) });
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <Button
        type="button"
        size={props.size ?? 'sm'}
        variant={props.variant ?? 'outline'}
        onClick={() => setOpen(true)}
        className="gap-2"
      >
        <Printer className="h-4 w-4" />
        Reprint
      </Button>

      <Dialog open={open} onOpenChange={(v) => !busy && setOpen(v)}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Reprint {props.documentKind.replace(/_/g, ' ')}</DialogTitle>
            <DialogDescription>
              {props.documentNumber ? <>Document <strong>{props.documentNumber}</strong>. </> : null}
              Reprints are recorded with your name, time, and reason. Tax-relevant
              documents are reviewable by auditors.
            </DialogDescription>
          </DialogHeader>

          <div className="space-y-2">
            <Label htmlFor="reprint-reason">Reason</Label>
            <Textarea
              id="reprint-reason"
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="e.g. customer requested duplicate, printer jam, lost copy"
              rows={3}
              disabled={busy}
            />
          </div>

          <DialogFooter>
            <Button variant="ghost" onClick={() => setOpen(false)} disabled={busy}>Cancel</Button>
            <Button onClick={handleConfirm} disabled={busy || !reason.trim()}>
              {busy ? <Loader2 className="h-4 w-4 animate-spin mr-2" /> : <Printer className="h-4 w-4 mr-2" />}
              Confirm reprint
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}

export default ReprintButton;
