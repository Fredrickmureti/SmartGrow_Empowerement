/**
 * OperatorDialog — enrol an employee as a warehouse operator and declare
 * what they are qualified to do. Skills and certifications entered here
 * are what the eligibility gate in `wms_operator_can_do_task` reads, so
 * this dialog is the control surface for who may execute what.
 */
import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle, DialogDescription,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  Select, SelectContent, SelectItem, SelectTrigger, SelectValue,
} from "@/components/ui/select";
import { X, Plus } from "lucide-react";
import {
  WMS_TASK_TYPES, useEnrollableEmployees, useOperatorMutations,
  type OperatorBoardRow, type OperatorCertification, type OperatorSkill, type WmsTaskType,
} from "./useLabourOperators";

interface Props {
  open: boolean;
  onOpenChange: (v: boolean) => void;
  warehouses: Array<{ id: string; name: string }>;
  defaultWarehouseId?: string;
  operator?: OperatorBoardRow | null;
  skills: OperatorSkill[];
  certifications: OperatorCertification[];
}

export function OperatorDialog({
  open, onOpenChange, warehouses, defaultWarehouseId, operator, skills, certifications,
}: Props) {
  const { data: employees } = useEnrollableEmployees();
  const { saveOperator } = useOperatorMutations();

  const [warehouseId, setWarehouseId] = useState("");
  const [employeeId, setEmployeeId] = useState("");
  const [operatorCode, setOperatorCode] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(1);
  const [isActive, setIsActive] = useState(true);
  const [equipment, setEquipment] = useState<string[]>([]);
  const [equipmentDraft, setEquipmentDraft] = useState("");
  const [skillRows, setSkillRows] = useState<Array<{ task_type: WmsTaskType; proficiency: number }>>([]);
  const [certRows, setCertRows] = useState<Array<{ code: string; label: string; expires_on: string }>>([]);

  useEffect(() => {
    if (!open) return;
    setWarehouseId(operator?.warehouse_id ?? defaultWarehouseId ?? warehouses[0]?.id ?? "");
    setEmployeeId(operator?.employee_id ?? "");
    setOperatorCode(operator?.operator_code ?? "");
    setMaxConcurrent(operator?.max_concurrent_tasks ?? 1);
    setIsActive(operator?.is_active ?? true);
    setEquipment(operator?.equipment_classes ?? []);
    setEquipmentDraft("");
    setSkillRows(
      operator
        ? skills.filter((s) => s.operator_id === operator.operator_id)
            .map((s) => ({ task_type: s.task_type, proficiency: s.proficiency }))
        : [],
    );
    setCertRows(
      operator
        ? certifications.filter((c) => c.operator_id === operator.operator_id)
            .map((c) => ({ code: c.code, label: c.label ?? "", expires_on: c.expires_on ?? "" }))
        : [],
    );
  }, [open, operator, defaultWarehouseId, warehouses, skills, certifications]);

  const selectedEmployee = (employees ?? []).find((e) => e.id === employeeId);

  const toggleSkill = (t: WmsTaskType) => {
    setSkillRows((rows) =>
      rows.some((r) => r.task_type === t)
        ? rows.filter((r) => r.task_type !== t)
        : [...rows, { task_type: t, proficiency: 3 }],
    );
  };

  const submit = () => {
    saveOperator.mutate(
      {
        id: operator?.operator_id,
        warehouse_id: warehouseId,
        employee_id: employeeId || null,
        user_id: selectedEmployee?.user_id ?? operator?.user_id ?? null,
        operator_code: operatorCode.trim() || null,
        equipment_classes: equipment,
        max_concurrent_tasks: Number(maxConcurrent) || 1,
        is_active: isActive,
        notes: null,
        skills: skillRows,
        certifications: certRows
          .filter((c) => c.code.trim())
          .map((c) => ({
            code: c.code.trim(),
            label: c.label.trim() || null,
            expires_on: c.expires_on || null,
          })),
      },
      { onSuccess: () => onOpenChange(false) },
    );
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{operator ? "Edit operator" : "Enrol operator"}</DialogTitle>
          <DialogDescription>
            Capability declared here drives task eligibility — an operator can only
            be assigned work they are skilled and certified for.
          </DialogDescription>
        </DialogHeader>

        <div className="grid gap-4">
          <div className="grid grid-cols-2 gap-4">
            <div className="space-y-1.5">
              <Label>Warehouse</Label>
              <Select value={warehouseId} onValueChange={setWarehouseId}>
                <SelectTrigger><SelectValue placeholder="Select warehouse" /></SelectTrigger>
                <SelectContent>
                  {warehouses.map((w) => (
                    <SelectItem key={w.id} value={w.id}>{w.name}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label>Employee</Label>
              <Select value={employeeId} onValueChange={setEmployeeId}>
                <SelectTrigger><SelectValue placeholder="Select employee" /></SelectTrigger>
                <SelectContent>
                  {(employees ?? []).map((e) => (
                    <SelectItem key={e.id} value={e.id}>
                      {[e.first_name, e.last_name].filter(Boolean).join(" ") || e.employee_number || e.id.slice(0, 8)}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
              {employeeId && !selectedEmployee?.user_id && (
                <p className="text-xs text-destructive">
                  This employee has no login yet — they cannot claim tasks until invited.
                </p>
              )}
            </div>
          </div>

          <div className="grid grid-cols-3 gap-4">
            <div className="space-y-1.5">
              <Label>Operator code</Label>
              <Input value={operatorCode} onChange={(e) => setOperatorCode(e.target.value)} placeholder="OP-014" />
            </div>
            <div className="space-y-1.5">
              <Label>Max concurrent tasks</Label>
              <Input
                type="number" min={1}
                value={maxConcurrent}
                onChange={(e) => setMaxConcurrent(Number(e.target.value))}
              />
            </div>
            <div className="space-y-1.5">
              <Label>Active</Label>
              <div className="flex h-10 items-center">
                <Switch checked={isActive} onCheckedChange={setIsActive} />
              </div>
            </div>
          </div>

          <div className="space-y-2">
            <Label>Equipment classes</Label>
            <div className="flex gap-2">
              <Input
                value={equipmentDraft}
                onChange={(e) => setEquipmentDraft(e.target.value)}
                placeholder="reach_truck, pallet_jack, rf_scanner…"
                onKeyDown={(e) => {
                  if (e.key === "Enter" && equipmentDraft.trim()) {
                    e.preventDefault();
                    setEquipment((v) => Array.from(new Set([...v, equipmentDraft.trim()])));
                    setEquipmentDraft("");
                  }
                }}
              />
              <Button
                type="button" variant="outline"
                onClick={() => {
                  if (!equipmentDraft.trim()) return;
                  setEquipment((v) => Array.from(new Set([...v, equipmentDraft.trim()])));
                  setEquipmentDraft("");
                }}
              >
                <Plus className="h-4 w-4" />
              </Button>
            </div>
            <div className="flex flex-wrap gap-2">
              {equipment.map((c) => (
                <Badge key={c} variant="secondary" className="gap-1">
                  {c}
                  <button type="button" onClick={() => setEquipment((v) => v.filter((x) => x !== c))}>
                    <X className="h-3 w-3" />
                  </button>
                </Badge>
              ))}
            </div>
          </div>

          <div className="space-y-2">
            <Label>Skills</Label>
            <div className="grid grid-cols-2 gap-2">
              {WMS_TASK_TYPES.map((t) => {
                const row = skillRows.find((r) => r.task_type === t);
                return (
                  <div
                    key={t}
                    className="flex items-center justify-between rounded-md border px-3 py-2"
                  >
                    <button
                      type="button"
                      className="text-sm capitalize"
                      onClick={() => toggleSkill(t)}
                    >
                      <span className={row ? "font-medium" : "text-muted-foreground"}>{t}</span>
                    </button>
                    {row ? (
                      <Select
                        value={String(row.proficiency)}
                        onValueChange={(v) =>
                          setSkillRows((rows) =>
                            rows.map((r) => (r.task_type === t ? { ...r, proficiency: Number(v) } : r)),
                          )
                        }
                      >
                        <SelectTrigger className="h-7 w-20"><SelectValue /></SelectTrigger>
                        <SelectContent>
                          {[1, 2, 3, 4, 5].map((p) => (
                            <SelectItem key={p} value={String(p)}>L{p}</SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    ) : (
                      <Button size="sm" variant="ghost" onClick={() => toggleSkill(t)}>Add</Button>
                    )}
                  </div>
                );
              })}
            </div>
          </div>

          <div className="space-y-2">
            <div className="flex items-center justify-between">
              <Label>Certifications</Label>
              <Button
                size="sm" variant="outline" type="button"
                onClick={() => setCertRows((r) => [...r, { code: "", label: "", expires_on: "" }])}
              >
                <Plus className="h-4 w-4 mr-1" /> Add
              </Button>
            </div>
            {certRows.length === 0 && (
              <p className="text-sm text-muted-foreground">No certifications recorded.</p>
            )}
            {certRows.map((c, i) => (
              <div key={i} className="grid grid-cols-[1fr_1fr_150px_40px] gap-2">
                <Input
                  placeholder="Code (e.g. FORKLIFT)"
                  value={c.code}
                  onChange={(e) =>
                    setCertRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, code: e.target.value } : r)))
                  }
                />
                <Input
                  placeholder="Label"
                  value={c.label}
                  onChange={(e) =>
                    setCertRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, label: e.target.value } : r)))
                  }
                />
                <Input
                  type="date"
                  value={c.expires_on}
                  onChange={(e) =>
                    setCertRows((rows) => rows.map((r, ri) => (ri === i ? { ...r, expires_on: e.target.value } : r)))
                  }
                />
                <Button
                  variant="ghost" size="icon" type="button"
                  onClick={() => setCertRows((rows) => rows.filter((_, ri) => ri !== i))}
                >
                  <X className="h-4 w-4" />
                </Button>
              </div>
            ))}
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>Cancel</Button>
          <Button onClick={submit} disabled={!warehouseId || saveOperator.isPending}>
            {saveOperator.isPending ? "Saving…" : "Save operator"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
