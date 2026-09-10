/**
 * Loan product detail sheet — the read-only view of an existing product.
 *
 * Opening a product means "show me how this product is configured", never
 * "put it into an editable form". Editing the product identity is a separate,
 * deliberate act behind the Edit action, and the commercial terms shown here
 * belong to the version in force, which is immutable by design — repricing
 * publishes a new version through the Versions dialog.
 */

import { History, Pencil } from "lucide-react";
import { DetailSheet, FooterActionBar, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import {
  MF_FEE_BASIS_LABELS,
  MF_FEE_COLLECTION_LABELS,
  MF_INTEREST_METHOD_LABELS,
  MF_PENALTY_BASIS_LABELS,
  MF_RATE_PERIOD_LABELS,
  useMfLoanProductVersions,
  type MfLoanProduct,
  type MfProductStatus,
} from "@/hooks/useMfLoanProducts";
import { Block, Field } from "../shared/detailFields";

const STATUS_TONE: Record<MfProductStatus, "neutral" | "success" | "warning" | "danger"> = {
  draft: "warning",
  active: "success",
  retired: "neutral",
};

interface Props {
  product: MfLoanProduct | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Whether the signed-in user may change product identity. */
  canManage: boolean;
  onEdit: () => void;
  onOpenVersions: () => void;
}

export function ProductDetailSheet({
  product,
  open,
  onOpenChange,
  canManage,
  onEdit,
  onOpenVersions,
}: Props) {
  // Reading the versions is what makes the sheet informative; it never writes.
  const { versions, currentVersion } = useMfLoanProductVersions(
    open ? (product?.id ?? null) : null,
  );

  if (!product) return null;

  const v = currentVersion;

  return (
    <DetailSheet
      open={open}
      onOpenChange={onOpenChange}
      size="lg"
      title={
        <span className="flex min-w-0 items-center gap-2">
          <span className="truncate">{product.name}</span>
          <StatusBadge tone={STATUS_TONE[product.status]}>{product.status}</StatusBadge>
        </span>
      }
      description={`Product ${product.code} · stored record`}
      footer={
        <FooterActionBar
          anchor="sheet"
          leading={
            <Button variant="outline" onClick={onOpenVersions}>
              <History className="mr-1.5 h-4 w-4" />
              Versions
            </Button>
          }
          trailing={
            <>
              <Button variant="outline" onClick={() => onOpenChange(false)}>
                Close
              </Button>
              {canManage && (
                <Button onClick={onEdit}>
                  <Pencil className="mr-1.5 h-4 w-4" />
                  Edit product
                </Button>
              )}
            </>
          }
        />
      }
    >
      <div className="space-y-6">
        <Block title="Identity">
          <Field label="Code" value={<span className="font-mono">{product.code}</span>} />
          <Field label="Name" value={product.name} />
          <Field label="Status" value={product.status} />
          <Field
            label="Pricing"
            value={v ? `Version ${v.version_no} in force` : "No published version"}
          />
          <div className="sm:col-span-2">
            <Field label="Description" value={product.description} />
          </div>
        </Block>

        <Separator />

        {v ? (
          <>
            <Block title={`Terms — version ${v.version_no}`}>
              <Field label="Currency" value={v.currency_code} />
              <Field label="Effective from" value={v.effective_from} />
              <Field
                label="Amount band"
                value={`${v.currency_code} ${v.min_amount} – ${v.max_amount}`}
              />
              <Field
                label="Term band"
                value={`${v.min_term_installments} – ${v.max_term_installments} installments`}
              />
              <Field label="Repayment frequency" value={v.repayment_frequency} />
              <Field label="Grace installments" value={v.grace_period_installments} />
            </Block>

            <Separator />

            <Block title="Interest">
              <Field label="Method" value={MF_INTEREST_METHOD_LABELS[v.interest_method]} />
              <Field label="Rate" value={`${v.interest_rate}%`} />
              <Field label="Rate basis" value={MF_RATE_PERIOD_LABELS[v.interest_rate_period]} />
            </Block>

            <Separator />

            <Block title="Fees">
              <div className="sm:col-span-2">
                {v.fees.length === 0 ? (
                  <p className="text-sm text-muted-foreground">No fees configured.</p>
                ) : (
                  <ul className="space-y-1.5 text-sm">
                    {v.fees.map((fee, i) => (
                      <li key={`${fee.name}-${i}`} className="flex flex-wrap gap-x-2">
                        <span className="font-medium">{fee.name}</span>
                        <span className="text-muted-foreground">
                          {fee.value}
                          {fee.basis === "percent_of_principal" ? "%" : ""} ·{" "}
                          {MF_FEE_BASIS_LABELS[fee.basis]} ·{" "}
                          {MF_FEE_COLLECTION_LABELS[fee.collection]}
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </Block>

            <Separator />

            <Block title="Penalties">
              <Field label="Penalty rate" value={`${v.penalty_rate}%`} />
              <Field label="Charged on" value={MF_PENALTY_BASIS_LABELS[v.penalty_basis]} />
            </Block>

            <Separator />

            <Block title="Eligibility">
              <Field label="Minimum completed cycles" value={v.eligibility?.min_completed_cycles} />
              <Field label="Maximum completed cycles" value={v.eligibility?.max_completed_cycles} />
              <Field label="Minimum age" value={v.eligibility?.min_age} />
              <Field label="Maximum age" value={v.eligibility?.max_age} />
              <Field
                label="Group membership"
                value={v.eligibility?.requires_group_membership ? "Required" : "Not required"}
              />
              <div className="sm:col-span-2">
                <Field label="Notes" value={v.eligibility?.notes} />
              </div>
            </Block>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">
            This product has no published version in force, so it carries no amounts,
            interest, fees or penalties yet and cannot be lent on.
          </p>
        )}

        <Separator />

        <Block title="History">
          <Field label="Published versions" value={versions.length} />
          <Field label="Last changed" value={product.updated_at?.slice(0, 10)} />
        </Block>
      </div>
    </DetailSheet>
  );
}

export default ProductDetailSheet;
