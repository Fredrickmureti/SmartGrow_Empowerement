/**
 * LearningPathsPage — Phase G. Manage curated learning paths and their
 * ordered course sequences. Path builder uses the existing training_courses
 * catalog. Quiz authoring lives on the course (see LearningPage).
 */
import { useState } from "react";
import { useLearningPaths, usePathCourses } from "@/hooks/useLearningPaths";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { useOrganization } from "@/hooks/useOrganization";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import { WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { GraduationCap, Plus, Trash2 } from "lucide-react";

const sb = supabase as any;

export default function LearningPathsPage() {
  const { paths, isLoading, create } = useLearningPaths();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ name: "", description: "", target_role: "", category: "" });

  const selected = paths.find(p => p.id === selectedId) ?? null;

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      <Card className="lg:col-span-1">
        <CardHeader>
          <div className="flex items-center justify-between">
            <CardTitle className="flex items-center gap-2"><GraduationCap className="h-5 w-5" /> Learning paths</CardTitle>
            <Button size="sm" onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New</Button>
            <TalentFormShell
              open={open}
              onOpenChange={setOpen}
              entity="learning-path"
              mode="create"
              busy={create.isPending}
              submitDisabled={!form.name}
              submitLabel="Create path"
              onSubmit={async () => {
                if (!form.name) return;
                const p = await create.mutateAsync(form);
                setOpen(false);
                setForm({ name: "", description: "", target_role: "", category: "" });
                if (p) setSelectedId((p as any).id);
              }}
            >
              <WorkflowSheetSection number={1} title="Identity">
                <WorkflowField label="Name" required>
                  <Input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="e.g. New Manager Foundations" />
                </WorkflowField>
                <WorkflowField label="Description">
                  <Textarea value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} rows={2} />
                </WorkflowField>
              </WorkflowSheetSection>
              <WorkflowSheetSection number={2} title="Audience" subtitle="Who is this path for? Used for discovery and recommendations.">
                <WorkflowSheetGrid>
                  <WorkflowField label="Target role">
                    <Input value={form.target_role} onChange={(e) => setForm({ ...form, target_role: e.target.value })} placeholder="People Manager" />
                  </WorkflowField>
                  <WorkflowField label="Category">
                    <Input value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })} placeholder="Leadership" />
                  </WorkflowField>
                </WorkflowSheetGrid>
              </WorkflowSheetSection>
            </TalentFormShell>
          </div>
          <CardDescription>Curated sequences of courses.</CardDescription>
        </CardHeader>
        <CardContent className="space-y-1">
          {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {paths.map(p => (
            <button key={p.id}
              onClick={() => setSelectedId(p.id)}
              className={`w-full text-left p-2 rounded border ${selectedId === p.id ? "bg-accent" : ""}`}>
              <div className="font-medium">{p.name}</div>
              <div className="text-xs text-muted-foreground line-clamp-1">
                {p.target_role || p.category || p.description || "—"}
              </div>
            </button>
          ))}
          {!isLoading && !paths.length && (
            <div className="text-sm text-muted-foreground">No paths yet — create one.</div>
          )}
        </CardContent>
      </Card>

      <div className="lg:col-span-2">
        {selected ? <PathDetail pathId={selected.id} name={selected.name} /> : (
          <Card><CardContent className="py-10 text-center text-muted-foreground">
            Select a learning path to manage its courses.
          </CardContent></Card>
        )}
      </div>
    </div>
  );
}

function PathDetail({ pathId, name }: { pathId: string; name: string }) {
  const { currentOrg } = useOrganization();
  const { rows, isLoading, addCourse, removeCourse } = usePathCourses(pathId);
  const [picked, setPicked] = useState<string>("");

  const { data: courses = [] } = useQuery({
    queryKey: ["training-courses-catalog", currentOrg?.id],
    enabled: !!currentOrg?.id,
    queryFn: async () => {
      const { data, error } = await sb
        .from("training_courses")
        .select("id, name, duration_hours, delivery_mode")
        .eq("organization_id", currentOrg!.id)
        .eq("is_active", true)
        .order("name");
      if (error) throw error;
      return data ?? [];
    },
  });

  const usedIds = new Set(rows.map((r: any) => r.course_id));
  const available = (courses as any[]).filter(c => !usedIds.has(c.id));

  return (
    <Card>
      <CardHeader>
        <CardTitle>{name}</CardTitle>
        <CardDescription>Add courses in the order learners should complete them.</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <div className="flex gap-2">
          <Select value={picked} onValueChange={setPicked}>
            <SelectTrigger className="w-[320px]"><SelectValue placeholder="Pick a course" /></SelectTrigger>
            <SelectContent>
              {available.map(c => (
                <SelectItem key={c.id} value={c.id}>{c.name}</SelectItem>
              ))}
            </SelectContent>
          </Select>
          <Button disabled={!picked} onClick={async () => {
            await addCourse.mutateAsync({ course_id: picked, sequence_no: rows.length + 1 });
            setPicked("");
          }}><Plus className="h-4 w-4 mr-1" /> Add</Button>
        </div>

        <div className="space-y-2">
          {isLoading && <div className="text-sm text-muted-foreground">Loading…</div>}
          {rows.map((r: any, idx) => (
            <div key={r.id} className="flex items-center justify-between border rounded p-2">
              <div className="flex items-center gap-3">
                <Badge variant="outline">#{idx + 1}</Badge>
                <div>
                  <div className="font-medium">{r.training_courses?.name ?? r.course_id}</div>
                  <div className="text-xs text-muted-foreground">
                    {r.training_courses?.duration_hours ? `${r.training_courses.duration_hours}h` : "—"}
                    {" · "}{r.training_courses?.delivery_mode ?? "self-paced"}
                    {r.is_required && " · required"}
                  </div>
                </div>
              </div>
              <Button size="icon" variant="ghost" onClick={() => removeCourse.mutate(r.id)}>
                <Trash2 className="h-4 w-4" />
              </Button>
            </div>
          ))}
          {!isLoading && !rows.length && (
            <div className="text-sm text-muted-foreground">No courses added yet.</div>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
