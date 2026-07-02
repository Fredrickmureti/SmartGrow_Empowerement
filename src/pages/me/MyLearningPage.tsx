/**
 * MyLearning — employee portal page that lists the current user's training
 * enrollments, lets them open course content (files, links, lessons), and
 * mark themselves as in-progress or complete (with optional certificate
 * upload when the course requires one).
 */
import { useMemo, useRef, useState } from "react";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useTrainingCourses, useTrainingEnrollments, type TrainingEnrollment, type TrainingCourse } from "@/hooks/usePerformance";
import { useCourseMaterials, type CourseMaterial } from "@/hooks/useCourseMaterials";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Progress } from "@/components/ui/progress";
import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogFooter, DialogDescription } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { BookOpen, Play, CheckCircle2, XCircle, Paperclip, Link2, FileText, Download, ExternalLink, Upload } from "lucide-react";
import { toast } from "sonner";

export default function MyLearning() {
  const { currentEmployee } = useCurrentEmployee();
  const { enrollments, isLoading, startEnrollment, completeEnrollment, dropEnrollment } = useTrainingEnrollments(currentEmployee?.id);
  const { courses } = useTrainingCourses();
  const courseById = useMemo(() => new Map(courses.map((c) => [c.id, c])), [courses]);

  const [openCourse, setOpenCourse] = useState<{ enrollment: TrainingEnrollment; course: TrainingCourse } | null>(null);
  const [completeOpen, setCompleteOpen] = useState<{ enrollment: TrainingEnrollment; course: TrainingCourse } | null>(null);

  if (!currentEmployee) {
    return (
      <Card>
        <CardHeader><CardTitle>My Learning</CardTitle><CardDescription>Your assigned courses and progress.</CardDescription></CardHeader>
        <CardContent><p className="text-sm text-muted-foreground">Ask your HR admin to link your account to your employee profile.</p></CardContent>
      </Card>
    );
  }

  const todo = enrollments.filter((e) => e.status === "enrolled");
  const inProgress = enrollments.filter((e) => e.status === "in_progress");
  const done = enrollments.filter((e) => e.status === "completed");
  const total = enrollments.filter((e) => e.status !== "dropped" && e.status !== "failed").length;
  const pct = total === 0 ? 0 : Math.round((done.length / total) * 100);

  function row(e: TrainingEnrollment) {
    const c = courseById.get(e.course_id);
    if (!c) return null;
    return (
      <div key={e.id} className="flex items-start justify-between gap-3 rounded-md border p-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap">
            <p className="font-medium">{c.name}</p>
            <Badge variant="outline" className="capitalize">{e.status.replace("_", " ")}</Badge>
            {c.requires_certificate && <Badge variant="secondary">Certificate required</Badge>}
            {e.due_date && <Badge variant={new Date(e.due_date) < new Date() && e.status !== "completed" ? "destructive" : "outline"}>Due {new Date(e.due_date).toLocaleDateString()}</Badge>}
          </div>
          {c.objectives && <p className="text-xs text-muted-foreground mt-1 line-clamp-2">{c.objectives}</p>}
          <div className="flex items-center gap-3 mt-2 text-xs text-muted-foreground">
            {c.provider && <span>{c.provider}</span>}
            {c.duration_hours && <span>{c.duration_hours}h</span>}
            {c.category && <span>{c.category}</span>}
          </div>
        </div>
        <div className="flex flex-col items-end gap-1.5 shrink-0">
          <Button size="sm" variant="outline" onClick={() => setOpenCourse({ enrollment: e, course: c })}>
            <BookOpen className="h-4 w-4 mr-1" /> Open
          </Button>
          {e.status === "enrolled" && (
            <Button size="sm" onClick={() => startEnrollment.mutate(e.id)}><Play className="h-4 w-4 mr-1" /> Start</Button>
          )}
          {(e.status === "enrolled" || e.status === "in_progress") && (
            <Button size="sm" variant="default" onClick={() => setCompleteOpen({ enrollment: e, course: c })}>
              <CheckCircle2 className="h-4 w-4 mr-1" /> Mark complete
            </Button>
          )}
          {e.status !== "completed" && e.status !== "dropped" && (
            <Button size="sm" variant="ghost" onClick={() => { if (confirm("Drop this course?")) dropEnrollment.mutate(e.id); }}>
              <XCircle className="h-4 w-4 mr-1" /> Drop
            </Button>
          )}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2"><BookOpen className="h-6 w-6" /> My Learning</h1>
          <p className="text-sm text-muted-foreground">Courses you've been enrolled in, with materials and completion tracking.</p>
        </div>
        <Button variant="outline" asChild><a href="/me/learning/catalog">Browse catalog</a></Button>
      </div>

      <Card>
        <CardContent className="pt-4 space-y-2">
          <div className="flex items-center justify-between text-sm">
            <span className="font-medium">Overall progress</span>
            <span className="text-muted-foreground">{done.length} of {total} completed</span>
          </div>
          <Progress value={pct} />
        </CardContent>
      </Card>

      {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : enrollments.length === 0 ? (
        <Card><CardContent className="py-10 text-center text-muted-foreground">You don't have any learning assigned yet.</CardContent></Card>
      ) : (
        <div className="space-y-6">
          <Section title="To do" items={inProgress.length === 0 ? todo : []} render={row} empty={inProgress.length > 0 ? null : "Nothing to start."} />
          {inProgress.length > 0 && <Section title="In progress" items={inProgress} render={row} />}
          {todo.length > 0 && inProgress.length > 0 && <Section title="Not started" items={todo} render={row} />}
          {done.length > 0 && <Section title="Completed" items={done} render={row} />}
        </div>
      )}

      {openCourse && (
        <CourseContentDialog
          course={openCourse.course}
          onClose={() => setOpenCourse(null)}
        />
      )}
      {completeOpen && (
        <CompleteDialog
          course={completeOpen.course}
          enrollment={completeOpen.enrollment}
          onClose={() => setCompleteOpen(null)}
          onSubmit={async ({ file, score }) => {
            await completeEnrollment.mutateAsync({ id: completeOpen.enrollment.id, certificateFile: file, score });
            setCompleteOpen(null);
          }}
        />
      )}
    </div>
  );
}

function Section({ title, items, render, empty }: { title: string; items: TrainingEnrollment[]; render: (e: TrainingEnrollment) => any; empty?: string | null }) {
  if (items.length === 0 && !empty) return null;
  return (
    <div className="space-y-2">
      <h2 className="text-sm font-semibold uppercase tracking-wide text-muted-foreground">{title}</h2>
      {items.length === 0 ? <p className="text-sm text-muted-foreground">{empty}</p> : items.map(render)}
    </div>
  );
}

function CourseContentDialog({ course, onClose }: { course: TrainingCourse; onClose: () => void }) {
  const { materials, isLoading } = useCourseMaterials(course.id);

  async function open(m: CourseMaterial) {
    if (m.kind === "link" && m.external_url) { window.open(m.external_url, "_blank"); return; }
    if (m.kind === "file" && m.file_path) {
      const { data, error } = await supabase.storage.from("documents").createSignedUrl(m.file_path, 60 * 60);
      if (error || !data?.signedUrl) { toast.error("Could not open file"); return; }
      window.open(data.signedUrl, "_blank");
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-w-2xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{course.name}</DialogTitle>
          {course.objectives && <DialogDescription className="whitespace-pre-wrap">{course.objectives}</DialogDescription>}
        </DialogHeader>
        {course.description && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{course.description}</p>}
        <div className="space-y-2">
          <h3 className="text-sm font-semibold">Course materials</h3>
          {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p> : materials.length === 0 ? (
            <p className="text-sm text-muted-foreground">No materials have been added to this course yet.</p>
          ) : (
            <ul className="space-y-2">
              {materials.map((m) => (
                <li key={m.id} className="rounded-md border p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="flex items-center gap-2 min-w-0">
                      {m.kind === "file" && <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />}
                      {m.kind === "link" && <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />}
                      {m.kind === "text" && <FileText className="h-4 w-4 text-muted-foreground shrink-0" />}
                      <p className="text-sm font-medium truncate">{m.title}</p>
                    </div>
                    {m.kind === "file" && (
                      <Button size="sm" variant="outline" onClick={() => open(m)}><Download className="h-4 w-4 mr-1" /> Download</Button>
                    )}
                    {m.kind === "link" && (
                      <Button size="sm" variant="outline" onClick={() => open(m)}><ExternalLink className="h-4 w-4 mr-1" /> Open</Button>
                    )}
                  </div>
                  {m.kind === "text" && m.content_text && (
                    <p className="text-sm whitespace-pre-wrap mt-2">{m.content_text}</p>
                  )}
                  {m.description && <p className="text-xs text-muted-foreground mt-1">{m.description}</p>}
                </li>
              ))}
            </ul>
          )}
        </div>
        <DialogFooter><Button variant="outline" onClick={onClose}>Close</Button></DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CompleteDialog({ course, onClose, onSubmit }: {
  course: TrainingCourse;
  enrollment: TrainingEnrollment;
  onClose: () => void;
  onSubmit: (input: { file?: File; score?: number }) => Promise<void>;
}) {
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [file, setFile] = useState<File | undefined>(undefined);
  const [score, setScore] = useState<string>("");
  const [submitting, setSubmitting] = useState(false);

  const needsCert = course.requires_certificate;
  const disabled = submitting || (needsCert && !file);

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Mark "{course.name}" complete</DialogTitle>
          <DialogDescription>
            {needsCert
              ? "This course requires a completion certificate. Upload it below to mark complete."
              : "Confirm you've completed this course."}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
          {needsCert && (
            <div>
              <Label>Certificate</Label>
              <input ref={fileRef} type="file" className="hidden" onChange={(e) => setFile(e.target.files?.[0])} />
              <div className="mt-1">
                <Button variant="outline" onClick={() => fileRef.current?.click()}>
                  <Upload className="h-4 w-4 mr-1" /> {file ? file.name : "Choose file"}
                </Button>
              </div>
              {course.pass_score != null && <p className="text-xs text-muted-foreground mt-1">Pass score: {course.pass_score}</p>}
            </div>
          )}
          <div>
            <Label>Score (optional)</Label>
            <Input type="number" step="0.1" value={score} onChange={(e) => setScore(e.target.value)} placeholder="e.g. 85" />
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={submitting}>Cancel</Button>
          <Button
            disabled={disabled}
            onClick={async () => {
              setSubmitting(true);
              try {
                await onSubmit({ file, score: score ? Number(score) : undefined });
              } finally {
                setSubmitting(false);
              }
            }}
          >
            {submitting ? "Saving…" : "Mark complete"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
