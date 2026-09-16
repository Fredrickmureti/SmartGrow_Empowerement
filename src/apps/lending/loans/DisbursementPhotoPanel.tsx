/**
 * Read-only evidence panel for a disbursed loan.
 *
 * Shows the client's registration portrait beside the photo captured at the
 * payout desk, so a reviewer can compare them after the fact. Both images live
 * in the private KYC store and are rendered through short-lived signed links;
 * nothing here writes.
 */
import { User } from "lucide-react";
import { useKycImageUrl } from "@/hooks/useMfClients";
import { useMfLoanDisbursement } from "@/hooks/useMfLoans";

interface Props {
  loanId: string | null | undefined;
  /** Registration portrait of the borrowing client, for comparison. */
  clientPhotoPath?: string | null;
  /** Only rendered for loans that have actually been paid out. */
  enabled: boolean;
}

function PhotoSlot({ label, url }: { label: string; url: string | null | undefined }) {
  return (
    <div className="space-y-1.5">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="flex h-28 w-24 items-center justify-center overflow-hidden rounded-md border bg-muted">
        {url ? (
          <img src={url} alt={label} className="h-full w-full object-cover" />
        ) : (
          <User className="h-6 w-6 text-muted-foreground" aria-hidden />
        )}
      </div>
    </div>
  );
}

export function DisbursementPhotoPanel({ loanId, clientPhotoPath, enabled }: Props) {
  const { data: disbursement } = useMfLoanDisbursement(enabled ? loanId : null);
  const { data: registrationUrl } = useKycImageUrl(enabled ? clientPhotoPath : null);
  const { data: payoutUrl } = useKycImageUrl(
    enabled ? (disbursement?.payout_photo_path ?? null) : null,
  );

  if (!enabled || !disbursement) return null;

  return (
    <div className="rounded-md border p-3">
      <p className="text-sm font-medium">Payout identity evidence</p>
      <div className="mt-2 flex gap-4">
        <PhotoSlot label="At registration" url={registrationUrl} />
        <PhotoSlot label="At payout" url={payoutUrl} />
      </div>
      {!disbursement.payout_photo_path && (
        <p className="mt-2 text-xs text-muted-foreground">
          No photo was taken when this loan was paid out.
        </p>
      )}
    </div>
  );
}

export default DisbursementPhotoPanel;
