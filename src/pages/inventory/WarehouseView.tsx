/**
 * Warehouse detail (RecordScaffold) — read-only object page for a single
 * warehouse. Composed on the design-system `RecordShell` +
 * `RecordHeader` primitives per `docs/design-system/records.md`.
 */
import type { ReactNode } from "react";
import { useNavigate, useParams, Link } from "react-router-dom";
import { ArrowLeft, Pencil, MapPin, User, Mail, Phone } from "lucide-react";

import {
  ActionBar,
  ErrorState,
  FooterActionBar,
  LoadingState,
  RecordHeader,
  RecordShell,
  Section,
  StatusBadge,
  FieldGrid,
  FieldCell,
} from "@/design-system";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { useWarehouses } from "@/hooks/useWarehouses";

const LIST_PATH = "/inventory-app/warehouses";

function Field({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground">{label}</p>
      <div className="text-sm">{children}</div>
    </div>
  );
}

export default function WarehouseView() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { warehouses, isLoading } = useWarehouses();

  if (isLoading) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Warehouse" title="Loading…" />}>
        <Section>
          <LoadingState />
        </Section>
      </RecordShell>
    );
  }

  const warehouse = id ? warehouses.find((w) => w.id === id) : null;
  if (!warehouse) {
    return (
      <RecordShell header={<RecordHeader eyebrow="Warehouse" title="Not found" />}>
        <Section>
          <ErrorState
            title="Warehouse not found"
            description="It may have been deleted or you don't have access."
            onRetry={() => navigate(LIST_PATH)}
          />
        </Section>
      </RecordShell>
    );
  }

  const location = [warehouse.address, warehouse.city, warehouse.country]
    .filter(Boolean)
    .join(", ");

  return (
    <RecordShell
      header={
        <RecordHeader
          eyebrow="Warehouse"
          title={warehouse.name}
          docNumber={warehouse.code || undefined}
          status={
            <div className="flex flex-wrap gap-1">
              <StatusBadge tone={warehouse.is_active ? "success" : "muted"}>
                {warehouse.is_active ? "Active" : "Inactive"}
              </StatusBadge>
              {warehouse.is_default && <Badge variant="outline">Default</Badge>}
            </div>
          }
          actions={
            <ActionBar>
              <Button variant="outline" size="sm" asChild>
                <Link to={LIST_PATH}>
                  <ArrowLeft className="mr-2 h-4 w-4" /> Back
                </Link>
              </Button>
              <Button size="sm" asChild>
                <Link to={`${LIST_PATH}/${warehouse.id}/edit`}>
                  <Pencil className="mr-2 h-4 w-4" /> Edit
                </Link>
              </Button>
            </ActionBar>
          }
        />
      }
      footer={
        <FooterActionBar
          trailing={
            <Button variant="outline" onClick={() => navigate(LIST_PATH)}>
              Close
            </Button>
          }
        />
      }
    >
      <Section title="Location" description="Where this warehouse lives.">
        <FieldGrid columns={2}>
          <FieldCell>
            <Field label="Name">{warehouse.name}</Field>
          </FieldCell>
          <FieldCell>
            <Field label="Code">{warehouse.code || "—"}</Field>
          </FieldCell>
          <FieldCell span={2}>
            <Field label="Address">
              <span className="flex items-start gap-2">
                <MapPin className="h-4 w-4 mt-0.5 text-muted-foreground" />
                {location || "—"}
              </span>
            </Field>
          </FieldCell>
          <FieldCell>
            <Field label="City">{warehouse.city || "—"}</Field>
          </FieldCell>
          <FieldCell>
            <Field label="Country">{warehouse.country || "—"}</Field>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section title="Manager" description="Point of contact for this location.">
        <FieldGrid columns={3}>
          <FieldCell>
            <Field label="Name">
              <span className="flex items-center gap-2">
                <User className="h-4 w-4 text-muted-foreground" />
                {warehouse.manager_name || "—"}
              </span>
            </Field>
          </FieldCell>
          <FieldCell>
            <Field label="Email">
              <span className="flex items-center gap-2">
                <Mail className="h-4 w-4 text-muted-foreground" />
                {warehouse.manager_email || "—"}
              </span>
            </Field>
          </FieldCell>
          <FieldCell>
            <Field label="Phone">
              <span className="flex items-center gap-2">
                <Phone className="h-4 w-4 text-muted-foreground" />
                {warehouse.manager_phone || "—"}
              </span>
            </Field>
          </FieldCell>
        </FieldGrid>
      </Section>

      <Section title="Status">
        <FieldGrid columns={2}>
          <FieldCell>
            <Field label="Active">{warehouse.is_active ? "Yes" : "No"}</Field>
          </FieldCell>
          <FieldCell>
            <Field label="Default warehouse">
              {warehouse.is_default ? "Yes" : "No"}
            </Field>
          </FieldCell>
        </FieldGrid>
      </Section>
    </RecordShell>
  );
}
