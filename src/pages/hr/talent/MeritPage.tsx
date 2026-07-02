/**
 * MeritPage — Phase F. Merit recommendation matrix per performance cycle.
 *
 * Workflow: pick cycle → load reviewable employees → edit % / amount /
 * new salary per row → propose → approve → apply (writes
 * employee_compensation_history). All status transitions go through
 * security-definer RPCs that re-check is_talent_admin.
 */
import { useEffect, useMemo, useState } from "react";
import { useTalentCycles } from "@/hooks/useTalent";
import { useMeritRecommendations, useMeritActions, MeritRecommendation, MeritProposeItem } from "@/hooks/useMerit";
import { useEmployees } from "@/hooks/useEmployees";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import { DollarSign, Check, X, Send, CheckCheck } from "lucide-react";

const sb = supabase as any;

interface Row {
  employee_id: string;
  employee_name: string;
  review_id: string | null;
  final_rating: number | null;
  current_salary: number;
  recommended_pct: number;
  recommended_amount: number;
  new_salary: number;
  effective_date: string;
  notes: string;
  status: MeritRecommendation["status"] | "new";
  rec_id?: string;
  selected: boolean;
}

export default function MeritPage() {
  const { cycles } = useTalentCycles();
  const [cycleId, setCycleId] = useState<string>("");
  useEffect(() => { if (!cycleId && cycles[0]) setCycleId(cycles[0].id); }, [cycles, cycleId]);

  const { employees } = useEmployees();
  const { rows: existing, isLoading } = useMeritRecommendations(cycleId);
  const { propose, approve, reject, apply } = useMeritActions();

  // pull reviews for cycle to seed rating
  const { data: reviews = [] } = useQuery({
    queryKey: ["cycle-reviews-final", cycleId],
    enabled: !!cycleId,
    queryFn: async () => {
      const { data, error } = await sb
        .from("performance_reviews")
        .select("id, employee_id, final_rating, overall_rating")
        .eq("cycle_id", cycleId)
        .eq("review_type", "manager");
      if (error) throw error;
      return data ?? [];
    },
  });

  const [rows, setRows] = useState<Row[]>([]);

  useEffect(() => {
    if (!cycleId || !employees) return;
    const recByEmp = new Map(existing.map(r => [r.employee_id, r]));
    const revByEmp = new Map(reviews.map((r: any) => [r.employee_id, r]));
    // Seed rows from union of employees with reviews + existing recs
    const empIds = new Set<string>([...reviews.map((r: any) => r.employee_id), ...existing.map(r => r.employee_id)]);
    const newRows: Row[] = [];
    for (const empId of empIds) {
      const emp = employees.find((e: any) => e.id === empId);
      const rec = recByEmp.get(empId);
      const rev = revByEmp.get(empId) as any;
      newRows.push({
        employee_id: empId,
        employee_name: emp ? `${emp.first_name ?? ""} ${emp.last_name ?? ""}`.trim() || emp.id : empId,
        review_id: rec?.review_id ?? rev?.id ?? null,
        final_rating: rec?.final_rating ?? rev?.final_rating ?? rev?.overall_rating ?? null,
        current_salary: Number(rec?.current_salary ?? 0),
        recommended_pct: Number(rec?.recommended_pct ?? 0),
        recommended_amount: Number(rec?.recommended_amount ?? 0),
        new_salary: Number(rec?.new_salary ?? 0),
        effective_date: rec?.effective_date ?? new Date().toISOString().slice(0, 10),
        notes: rec?.notes ?? "",
        status: rec?.status ?? "new",
        rec_id: rec?.id,
        selected: false,
      });
    }
    newRows.sort((a, b) => a.employee_name.localeCompare(b.employee_name));
    setRows(newRows);
  }, [cycleId, employees, existing, reviews]);

  const updateRow = (i: number, patch: Partial<Row>) => {
    setRows(prev => {
      const next = [...prev];
      const row = { ...next[i], ...patch };
      if ("recommended_pct" in patch || "current_salary" in patch) {
        row.recommended_amount = +((row.current_salary * row.recommended_pct) / 100).toFixed(2);
        row.new_salary = +(row.current_salary + row.recommended_amount).toFixed(2);
      } else if ("recommended_amount" in patch) {
        row.new_salary = +(row.current_salary + row.recommended_amount).toFixed(2);
        row.recommended_pct = row.current_salary > 0
          ? +((row.recommended_amount / row.current_salary) * 100).toFixed(2)
          : 0;
      } else if ("new_salary" in patch) {
        row.recommended_amount = +(row.new_salary - row.current_salary).toFixed(2);
        row.recommended_pct = row.current_salary > 0
          ? +((row.recommended_amount / row.current_salary) * 100).toFixed(2)
          : 0;
      }
      next[i] = row;
      return next;
    });
  };

  const selectedIds = useMemo(
    () => rows.filter(r => r.selected && r.rec_id).map(r => r.rec_id!),
    [rows]
  );

  const proposeSelected = async (status: "draft" | "proposed") => {
    const sel = rows.filter(r => r.selected);
    if (!sel.length) return;
    const items: MeritProposeItem[] = sel.map(r => ({
      employee_id: r.employee_id,
      review_id: r.review_id,
      final_rating: r.final_rating,
      current_salary: r.current_salary,
      recommended_pct: r.recommended_pct,
      recommended_amount: r.recommended_amount,
      new_salary: r.new_salary,
      effective_date: r.effective_date,
      notes: r.notes || null,
      status,
    }));
    await propose.mutateAsync({ cycleId, items });
  };

  const statusBadge = (s: Row["status"]) => {
    const map: Record<string, string> = {
      new: "outline",
      draft: "secondary",
      proposed: "default",
      approved: "default",
      rejected: "destructive",
      applied: "default",
    };
    return <Badge variant={map[s] as any}>{s}</Badge>;
  };

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-4 flex-wrap">
          <div>
            <CardTitle className="flex items-center gap-2"><DollarSign className="h-5 w-5" /> Merit & Compensation</CardTitle>
            <CardDescription>
              Propose, approve, and apply merit increases tied to a performance cycle.
              Apply writes a row to compensation history (change type: merit_increase).
            </CardDescription>
          </div>
          <Select value={cycleId} onValueChange={setCycleId}>
            <SelectTrigger className="w-[280px]"><SelectValue placeholder="Select cycle" /></SelectTrigger>
            <SelectContent>
              {cycles.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => proposeSelected("draft")} disabled={!rows.some(r => r.selected)}>
            Save as draft
          </Button>
          <Button size="sm" onClick={() => proposeSelected("proposed")} disabled={!rows.some(r => r.selected)}>
            <Send className="h-4 w-4 mr-1" /> Propose
          </Button>
          <Button size="sm" variant="default" disabled={!selectedIds.length}
            onClick={() => approve.mutate({ cycleId, ids: selectedIds })}>
            <Check className="h-4 w-4 mr-1" /> Approve
          </Button>
          <Button size="sm" variant="destructive" disabled={!selectedIds.length}
            onClick={() => {
              const reason = window.prompt("Rejection reason?") ?? "";
              if (reason) reject.mutate({ cycleId, ids: selectedIds, reason });
            }}>
            <X className="h-4 w-4 mr-1" /> Reject
          </Button>
          <Button size="sm" variant="default" disabled={!selectedIds.length}
            onClick={() => apply.mutate({ cycleId, ids: selectedIds })}>
            <CheckCheck className="h-4 w-4 mr-1" /> Apply
          </Button>
        </div>

        <div className="border rounded-md overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead className="w-8" />
                <TableHead>Employee</TableHead>
                <TableHead>Rating</TableHead>
                <TableHead>Current</TableHead>
                <TableHead>%</TableHead>
                <TableHead>Amount</TableHead>
                <TableHead>New salary</TableHead>
                <TableHead>Effective</TableHead>
                <TableHead>Status</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading && <TableRow><TableCell colSpan={9}>Loading…</TableCell></TableRow>}
              {!isLoading && rows.length === 0 && (
                <TableRow><TableCell colSpan={9} className="text-muted-foreground text-center py-6">
                  No reviewable employees in this cycle yet.
                </TableCell></TableRow>
              )}
              {rows.map((r, i) => {
                const locked = r.status === "applied" || r.status === "rejected";
                return (
                  <TableRow key={r.employee_id}>
                    <TableCell>
                      <Checkbox checked={r.selected} onCheckedChange={(v) => updateRow(i, { selected: !!v })} />
                    </TableCell>
                    <TableCell className="font-medium">{r.employee_name}</TableCell>
                    <TableCell>{r.final_rating ?? "—"}</TableCell>
                    <TableCell>
                      <Input type="number" disabled={locked} className="w-28" value={r.current_salary}
                        onChange={(e) => updateRow(i, { current_salary: Number(e.target.value) })} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" disabled={locked} className="w-20" value={r.recommended_pct}
                        onChange={(e) => updateRow(i, { recommended_pct: Number(e.target.value) })} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" disabled={locked} className="w-28" value={r.recommended_amount}
                        onChange={(e) => updateRow(i, { recommended_amount: Number(e.target.value) })} />
                    </TableCell>
                    <TableCell>
                      <Input type="number" disabled={locked} className="w-28" value={r.new_salary}
                        onChange={(e) => updateRow(i, { new_salary: Number(e.target.value) })} />
                    </TableCell>
                    <TableCell>
                      <Input type="date" disabled={locked} className="w-36" value={r.effective_date}
                        onChange={(e) => updateRow(i, { effective_date: e.target.value })} />
                    </TableCell>
                    <TableCell>{statusBadge(r.status)}</TableCell>
                  </TableRow>
                );
              })}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
