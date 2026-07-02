/**
 * My Competencies — employee self-assessment surface.
 *
 * Lists the competencies the employee should self-assess (role requirements
 * for their job position, plus all core competencies). Shows the proficiency
 * scale, the current self/manager/final levels, and lets them submit a
 * new self-rating that notifies their manager.
 */
import { useMemo, useState } from "react";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import {
  useCompetencies,
  useCompetencyScales,
  useRoleRequirements,
  useCompetencyAssessments,
  requiredLevelFor,
  DEFAULT_SCALE,
} from "@/hooks/useCompetencyFramework";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Slider } from "@/components/ui/slider";
import { Badge } from "@/components/ui/badge";
import { Award, Send } from "lucide-react";

export default function MyCompetencies() {
  const { currentEmployee } = useCurrentEmployee();
  const { competencies } = useCompetencies();
  const { requirements } = useRoleRequirements();
  const { defaultScale } = useCompetencyScales();
  const { assessments, submitAssessment } = useCompetencyAssessments({ employeeId: currentEmployee?.id });

  const scale = defaultScale?.levels ?? DEFAULT_SCALE;
  const max = scale.length;

  const relevant = useMemo(() => {
    if (!currentEmployee) return [];
    return competencies.filter((c) => {
      if (c.is_core) return true;
      const req = requiredLevelFor(requirements, c.id, null, currentEmployee.department_id);
      return req != null;
    });
  }, [competencies, requirements, currentEmployee]);

  if (!currentEmployee) {
    return (
      <Card>
        <CardHeader><CardTitle>My competencies</CardTitle><CardDescription>Requires a linked employee profile.</CardDescription></CardHeader>
      </Card>
    );
  }

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><Award className="h-5 w-5" /> My competencies</h1>
        <p className="text-sm text-muted-foreground">Rate yourself against the skills that matter for your role. Your manager will review and finalise.</p>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Proficiency scale</CardTitle></CardHeader>
        <CardContent className="grid sm:grid-cols-2 lg:grid-cols-5 gap-2 text-xs">
          {scale.map((l) => (
            <div key={l.level} className="rounded border p-2">
              <p className="font-semibold">{l.level} — {l.label}</p>
              {l.description ? <p className="text-muted-foreground mt-1">{l.description}</p> : null}
            </div>
          ))}
        </CardContent>
      </Card>

      {relevant.length === 0 ? (
        <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">No competencies have been assigned to your role yet. Ask your manager or HR.</CardContent></Card>
      ) : relevant.map((c) => {
        const a = assessments.find((x) => x.competency_id === c.id);
        const required = requiredLevelFor(requirements, c.id, null, currentEmployee.department_id);
        return (
          <AssessmentCard
            key={c.id}
            competency={c}
            max={max}
            required={required}
            assessment={a}
            onSubmit={(level, comment) =>
              submitAssessment.mutate({
                employee_id: currentEmployee.id,
                competency_id: c.id,
                required_level: required,
                side: "self",
                level,
                comment,
              })
            }
            disabled={submitAssessment.isPending}
          />
        );
      })}
    </div>
  );
}

function AssessmentCard({ competency, max, required, assessment, onSubmit, disabled }: {
  competency: { name: string; description: string | null; category: string | null };
  max: number;
  required: number | null;
  assessment?: { self_level: number | null; manager_level: number | null; final_level: number | null };
  onSubmit: (level: number, comment: string) => void;
  disabled: boolean;
}) {
  const [level, setLevel] = useState<number>(assessment?.self_level ?? 1);
  const [comment, setComment] = useState("");
  const gap = assessment?.final_level != null && required != null ? assessment.final_level - required : null;

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-2">
          <div>
            <CardTitle className="text-base">{competency.name}</CardTitle>
            {competency.description ? <CardDescription>{competency.description}</CardDescription> : null}
          </div>
          <div className="flex flex-wrap gap-1">
            {required != null ? <Badge variant="outline">required L{required}</Badge> : null}
            {assessment?.self_level != null ? <Badge variant="secondary">self L{assessment.self_level}</Badge> : null}
            {assessment?.manager_level != null ? <Badge variant="secondary">mgr L{assessment.manager_level}</Badge> : null}
            {assessment?.final_level != null ? <Badge>final L{assessment.final_level}</Badge> : null}
            {gap != null && gap < 0 ? <Badge variant="destructive">gap {gap}</Badge> : null}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-3">
        <div>
          <Label className="text-xs">Your self-rating ({level}/{max})</Label>
          <Slider value={[level]} onValueChange={(v) => setLevel(v[0])} max={max} min={1} step={1} className="mt-2 max-w-md" />
        </div>
        <div>
          <Label className="text-xs">Comments (evidence, examples)</Label>
          <Textarea rows={2} value={comment} onChange={(e) => setComment(e.target.value)} />
        </div>
        <Button size="sm" onClick={() => onSubmit(level, comment)} disabled={disabled}>
          <Send className="h-4 w-4 mr-1" /> Submit self-assessment
        </Button>
      </CardContent>
    </Card>
  );
}
