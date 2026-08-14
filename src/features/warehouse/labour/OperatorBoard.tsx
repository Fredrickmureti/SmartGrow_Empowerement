/**
 * OperatorBoard — the roster as a live control surface.
 *
 * Shows who is on shift, what they are qualified for, how loaded they
 * are, and today's earned-vs-actual. Availability changes dispatch the
 * `wms_set_operator_status` RPC; capability changes open the dialog.
 */
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table, TableBody, TableCell, TableHead, TableHeader, TableRow,
} from "@/components/ui/table";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { EmptyState, LoadingState } from "@/design-system";
import { Pencil, Trash2, UserPlus } from "lucide-react";
import {
  OPERATOR_STATUSES, OPERATOR_STATUS_LABELS,
  useOperatorBoard, useOperatorCertifications, useOperatorMutations, useOperatorSkills,
  type OperatorBoardRow, type OperatorStatus,
} from "./useLabourOperators";
import { OperatorDialog } from "./OperatorDialog";
import { LabourWorksheetButton } from "./LabourWorksheetButton";

function statusVariant(s: OperatorStatus): "default" | "secondary" | "outline" | "destructive" {
  if (s === "executing") return "default";
  if (s === "on_shift") return "secondary";
  if (s === "break") return "outline";
  return "outline";
}

function ratio(earned: number, actual: number): string {
  if (!actual) return "—";
  return `${Math.round((earned / actual) * 100)}%`;
}

interface Props {
  warehouseId: string;
  warehouses: Array<{ id: string; name: string }>;
}

export function OperatorBoard({ warehouseId, warehouses }: Props) {
  const { data: operators, isLoading } = useOperatorBoard(warehouseId);
  const { data: skills } = useOperatorSkills();
  const { data: certs } = useOperatorCertifications();
  const { setStatus, removeOperator } = useOperatorMutations();
  const [dialogOpen, setDialogOpen] = useState(false);
  const [editing, setEditing] = useState<OperatorBoardRow | null>(null);

  const skillsByOperator = useMemo(() => {
    const m = new Map<string, string[]>();
    for (const s of skills ?? []) {
      const list = m.get(s.operator_id) ?? [];
      list.push(`${s.task_type} L${s.proficiency}`);
      m.set(s.operator_id, list);
    }
    return m;
  }, [skills]);

  const expiringCerts = useMemo(() => {
    const m = new Map<string, number>();
    const soon = new Date();
    soon.setDate(soon.getDate() + 30);
    for (const c of certs ?? []) {
      if (c.expires_on && new Date(c.expires_on) <= soon) {
        m.set(c.operator_id, (m.get(c.operator_id) ?? 0) + 1);
      }
    }
    return m;
  }, [certs]);

  const openNew = () => { setEditing(null); setDialogOpen(true); };

  if (isLoading) return <LoadingState />;

  return (
    <>
      <div className="flex justify-end mb-3">
        <Button onClick={openNew}>
          <UserPlus className="h-4 w-4 mr-2" /> Enrol operator
        </Button>
      </div>

      {(operators ?? []).length === 0 ? (
        <EmptyState
          title="No operators enrolled"
          description="Enrol employees as warehouse operators to enable skill-aware task assignment."
          action={<Button onClick={openNew}>Enrol operator</Button>}
        />
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Operator</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Skills</TableHead>
              <TableHead>Equipment</TableHead>
              <TableHead className="text-right">Load</TableHead>
              <TableHead className="text-right">Today</TableHead>
              <TableHead className="w-24" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {(operators ?? []).map((o) => {
              const opSkills = skillsByOperator.get(o.operator_id) ?? [];
              const expiring = expiringCerts.get(o.operator_id) ?? 0;
              return (
                <TableRow key={o.operator_id}>
                  <TableCell>
                    <div className="font-medium">
                      {o.operator_name || o.operator_code || o.operator_id.slice(0, 8)}
                    </div>
                    <div className="text-xs text-muted-foreground">
                      {o.operator_code ?? o.employee_number ?? "—"}
                      {!o.is_active && " · inactive"}
                      {!o.user_id && " · no login"}
                    </div>
                    {expiring > 0 && (
                      <Badge variant="destructive" className="mt-1">
                        {expiring} cert{expiring > 1 ? "s" : ""} expiring
                      </Badge>
                    )}
                  </TableCell>
                  <TableCell>
                    <Select
                      value={o.status}
                      onValueChange={(v) =>
                        setStatus.mutate({ operatorId: o.operator_id, status: v as OperatorStatus, rowVersion: o.row_version })
                      }
                    >
                      <SelectTrigger className="h-8 w-36">
                        <SelectValue />
                      </SelectTrigger>
                      <SelectContent>
                        {OPERATOR_STATUSES.map((s) => (
                          <SelectItem key={s} value={s}>{OPERATOR_STATUS_LABELS[s]}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                    <Badge variant={statusVariant(o.status)} className="mt-1">
                      {OPERATOR_STATUS_LABELS[o.status]}
                    </Badge>
                  </TableCell>
                  <TableCell className="max-w-[220px]">
                    {opSkills.length === 0 ? (
                      <span className="text-xs text-muted-foreground">None declared</span>
                    ) : (
                      <div className="flex flex-wrap gap-1">
                        {opSkills.map((s) => (
                          <Badge key={s} variant="outline" className="capitalize text-xs">{s}</Badge>
                        ))}
                      </div>
                    )}
                  </TableCell>
                  <TableCell className="max-w-[180px]">
                    <div className="flex flex-wrap gap-1">
                      {(o.equipment_classes ?? []).map((c) => (
                        <Badge key={c} variant="secondary" className="text-xs">{c}</Badge>
                      ))}
                    </div>
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {o.open_tasks}/{o.max_concurrent_tasks}
                  </TableCell>
                  <TableCell className="text-right tabular-nums">
                    {ratio(Number(o.earned_seconds_today), Number(o.actual_seconds_today))}
                  </TableCell>
                  <TableCell>
                    <div className="flex justify-end gap-1">
                      <LabourWorksheetButton operatorId={o.operator_id} />
                      <Button
                        size="icon" variant="ghost"
                        onClick={() => { setEditing(o); setDialogOpen(true); }}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        size="icon" variant="ghost"
                        onClick={() => removeOperator.mutate(o.operator_id)}
                      >
                        <Trash2 className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      )}

      <OperatorDialog
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        warehouses={warehouses}
        defaultWarehouseId={warehouseId !== "all" ? warehouseId : undefined}
        operator={editing}
        skills={skills ?? []}
        certifications={certs ?? []}
      />
    </>
  );
}
