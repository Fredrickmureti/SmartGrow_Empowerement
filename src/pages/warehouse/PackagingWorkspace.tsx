/**
 * PackagingWorkspace — the management workspace for one packaging type
 * (ADR 0122).
 *
 * Specification, carrier rules, warehouse availability and the activity
 * journal each get full width. The catalogue keeps a preview pane and
 * links here; nothing is edited in a 420px column any more.
 */
import { useMemo } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { LoadingState, ErrorState, StatusBadge, Section } from "@/design-system";
import { useBusinesses } from "@/hooks/useBusinesses";
import { EntityWorkspaceShell } from "@/features/warehouse/entity/EntityWorkspaceShell";
import {
  LIFECYCLE_TONE, packagingErrorMessage, usePackagingTypes,
} from "@/features/warehouse/packaging/packagingMaster";
import { PackagingSpecForm } from "@/features/warehouse/packaging/workspace/PackagingSpecForm";
import {
  PackagingActivityPanel, PackagingAvailabilityPanel, PackagingCarriersPanel,
} from "@/features/warehouse/packaging/workspace/PackagingDetailPanels";

const LIST_PATH = "/warehouse-app/packaging";

export default function PackagingWorkspace() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { currentBusiness } = useBusinesses();
  const businessId = currentBusiness?.id;
  const { data: rows, isLoading } = usePackagingTypes(businessId);

  const creating = id === "new";
  const record = useMemo(
    () => (rows ?? []).find((r) => r.id === id) ?? null,
    [rows, id],
  );

  if (creating) {
    return (
      <EntityWorkspaceShell
        eyebrow="Packaging"
        title="New packaging type"
        backHref={LIST_PATH}
        backLabel="Catalogue"
        tabs={[
          {
            value: "spec",
            label: "Specification",
            render: () => (
              <Section title="Specification">
                <PackagingSpecForm
                  businessId={businessId}
                  record={null}
                  onCancel={() => navigate(LIST_PATH)}
                  onSaved={(row) => navigate(`${LIST_PATH}/${row.id}`)}
                />
              </Section>
            ),
          },
        ]}
      />
    );
  }

  if (isLoading) return <LoadingState />;
  if (!record) {
    return (
      <ErrorState
        title="Packaging type not found"
        description="It may have been deleted, or belongs to another business."
        onRetry={() => navigate(LIST_PATH)}
      />
    );
  }

  return (
    <EntityWorkspaceShell
      eyebrow="Packaging"
      title={record.code}
      docNumber={record.name}
      backHref={`${LIST_PATH}?sel=${record.id}`}
      backLabel="Catalogue"
      status={
        <StatusBadge tone={LIFECYCLE_TONE[record.lifecycle_status]}>
          {record.lifecycle_status}
        </StatusBadge>
      }
      meta={
        <span className="text-xs capitalize text-muted-foreground">
          Class {record.packaging_class} · version {record.row_version}
        </span>
      }
      tabs={[
        {
          value: "spec",
          label: "Specification",
          render: () => (
            <Section title="Specification">
              <PackagingSpecForm
                businessId={businessId}
                record={record}
                onSaved={() => toast.success("Packaging saved")}
              />
            </Section>
          ),
        },
        {
          value: "carriers",
          label: "Carriers",
          render: () => (
            <Section title="Carrier rules">
              <PackagingCarriersPanel packagingTypeId={record.id} businessId={businessId} />
            </Section>
          ),
        },
        {
          value: "availability",
          label: "Availability",
          render: () => (
            <Section title="Warehouse availability">
              <PackagingAvailabilityPanel packagingTypeId={record.id} businessId={businessId} />
            </Section>
          ),
        },
        {
          value: "activity",
          label: "Activity",
          render: () => (
            <Section title="Activity journal">
              <PackagingActivityPanel packagingTypeId={record.id} businessId={businessId} />
            </Section>
          ),
        },
      ]}
    />
  );
}

// `packagingErrorMessage` is the sanctioned error surface for this module;
// re-exported use lives in the panels themselves.
void packagingErrorMessage;
