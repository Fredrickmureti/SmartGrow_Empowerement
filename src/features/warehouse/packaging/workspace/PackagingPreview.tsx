/**
 * PackagingPreview — the catalogue side pane (ADR 0122).
 *
 * Geometry at a glance plus the two acts a planner performs from the list:
 * move the lifecycle on, or archive. Editing the specification, carrier
 * rules, availability and history happens on the packaging workspace.
 */
import { Archive } from "lucide-react";
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { StatusBadge } from "@/design-system";
import {
  LIFECYCLE_TONE, PACKAGING_LIFECYCLES, dimWeightKg, usableVolumeCm3,
  type PackagingLifecycle, type PackagingType,
} from "../packagingMaster";
import {
  EntityPreview, PreviewFact,
} from "@/features/warehouse/entity/EntityPreview";

export function packagingWorkspaceHref(id: string) {
  return `/warehouse-app/packaging/${id}`;
}

export function PackagingPreview({
  record,
  onLifecycleChange,
  onArchive,
}: {
  record: PackagingType;
  onLifecycleChange: (status: PackagingLifecycle) => void;
  onArchive: () => void;
}) {
  const dim = dimWeightKg(record);
  return (
    <EntityPreview
      eyebrow="Packaging"
      title={record.code}
      subtitle={record.name}
      status={
        <StatusBadge tone={LIFECYCLE_TONE[record.lifecycle_status]}>
          {record.lifecycle_status}
        </StatusBadge>
      }
      metrics={[
        { label: "Usable cm³", value: Math.round(usableVolumeCm3(record)).toLocaleString() },
        { label: "Max kg", value: String(record.max_weight_kg) },
      ]}
      workspaceHref={packagingWorkspaceHref(record.id)}
      workspaceLabel="Open packaging workspace"
      actions={
        <>
          <Select
            value={record.lifecycle_status}
            onValueChange={(v) => onLifecycleChange(v as PackagingLifecycle)}
          >
            <SelectTrigger className="h-9 w-full @sm/page:w-[150px]"><SelectValue /></SelectTrigger>
            <SelectContent>
              {PACKAGING_LIFECYCLES.map((l) => (
                <SelectItem key={l} value={l} className="capitalize">{l}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <AlertDialog>
            <AlertDialogTrigger asChild>
              <Button variant="outline" size="icon" aria-label="Archive packaging type">
                <Archive className="h-4 w-4" />
              </Button>
            </AlertDialogTrigger>
            <AlertDialogContent>
              <AlertDialogHeader>
                <AlertDialogTitle>Archive {record.code}?</AlertDialogTitle>
                <AlertDialogDescription>
                  If any carton ever used this packaging it is retired instead of deleted,
                  so the audit trail survives.
                </AlertDialogDescription>
              </AlertDialogHeader>
              <AlertDialogFooter>
                <AlertDialogCancel>Cancel</AlertDialogCancel>
                <AlertDialogAction onClick={onArchive}>Archive</AlertDialogAction>
              </AlertDialogFooter>
            </AlertDialogContent>
          </AlertDialog>
        </>
      }
    >
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Specification</h3>
        <PreviewFact label="Class" value={<span className="capitalize">{record.packaging_class}</span>} />
        <PreviewFact label="Material" value={record.material || "—"} />
        <PreviewFact
          label="Inner (cm)"
          value={`${record.inner_length_cm}×${record.inner_width_cm}×${record.inner_height_cm}`}
        />
        <PreviewFact
          label="Outer (cm)"
          value={`${record.outer_length_cm}×${record.outer_width_cm}×${record.outer_height_cm}`}
        />
        <PreviewFact label="Tare kg" value={String(record.tare_weight_kg)} />
        <PreviewFact label="Dim weight kg" value={dim === null ? "—" : dim.toFixed(2)} />
        <PreviewFact label="Version" value={String(record.row_version)} />
      </section>
    </EntityPreview>
  );
}

export default PackagingPreview;
