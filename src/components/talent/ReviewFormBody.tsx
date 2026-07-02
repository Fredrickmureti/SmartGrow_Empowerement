/**
 * ReviewFormBody — shared reviewer surface used by both HR/manager
 * (/hr/talent/reviews/:id) and employee self-review (/me/talent/reviews/:id).
 *
 * Behaviour:
 *   - If status is acknowledged or cancelled → read-only.
 *   - If signed_off → reviewee can acknowledge.
 *   - If submitted → HR/manager (sign-off authority) can sign off.
 *   - Else if the current user is the reviewer → editable (save responses + submit).
 *   - Otherwise → read-only summary.
 */
import { useEffect, useMemo, useState } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useReview, type ReviewStatus } from "@/hooks/useReviews";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Slider } from "@/components/ui/slider";
import { Send, CheckCircle2, ShieldCheck } from "lucide-react";

const STATUS_VARIANT: Record<ReviewStatus, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline", in_progress: "secondary", submitted: "default",
  calibrated: "secondary", signed_off: "default", acknowledged: "default", cancelled: "destructive",
};

interface Props {
  reviewId?: string;
  backHref: string;
}

export function ReviewFormBody({ reviewId }: Props) {
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const { review, sections, questions, responses, isLoading, saveResponse, submitReview, signOff, acknowledge } = useReview(reviewId);

  const [answers, setAnswers] = useState<Record<string, { rating?: number | null; comment?: string | null }>>({});
  const [overall, setOverall] = useState<number>(0);
  const [summary, setSummary] = useState("");
  const [strengths, setStrengths] = useState("");
  const [devAreas, setDevAreas] = useState("");
  const [finalRating, setFinalRating] = useState<number>(0);
  const [calibrationNotes, setCalibrationNotes] = useState("");

  useEffect(() => {
    const map: Record<string, { rating?: number | null; comment?: string | null }> = {};
    for (const r of responses) {
      if (r.question_id) map[r.question_id] = { rating: r.rating, comment: r.comment };
    }
    setAnswers(map);
  }, [responses]);

  useEffect(() => {
    if (review) {
      setOverall(review.overall_rating ?? 0);
      setSummary(review.summary ?? "");
      setStrengths(review.strengths ?? "");
      setDevAreas(review.development_areas ?? "");
      setFinalRating(review.final_rating ?? 0);
      setCalibrationNotes(review.calibration_notes ?? "");
    }
  }, [review]);

  const isReviewer = !!review && !!user && review.reviewer_user_id === user.id;
  const isReviewee = !!review && !!currentEmployee && review.employee_id === currentEmployee.id;
  const visibleQuestions = useMemo(
    () => questions.filter((q) => !review || q.audiences.includes(review.review_type)),
    [questions, review],
  );

  if (isLoading) return <p className="text-sm text-muted-foreground">Loading…</p>;
  if (!review) return <p className="text-sm text-muted-foreground">Review not found.</p>;

  const editable = isReviewer && (review.status === "draft" || review.status === "in_progress");
  const canSignOff = review.status === "submitted" && !isReviewee;
  const canAcknowledge = review.status === "signed_off" && isReviewee;

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-2">
            <div>
              <CardTitle className="text-xl capitalize">{review.review_type.replace(/_/g, " ")} review</CardTitle>
              <CardDescription>
                Employee {review.employee_id.slice(0, 8)}… ·
                {review.due_at ? ` Due ${new Date(review.due_at).toLocaleDateString()}` : " No due date"}
              </CardDescription>
            </div>
            <Badge variant={STATUS_VARIANT[review.status]}>{review.status.replace(/_/g, " ")}</Badge>
          </div>
        </CardHeader>
      </Card>

      {sections.length === 0 ? (
        <Card><CardContent className="py-6 text-sm text-muted-foreground">This template has no sections yet.</CardContent></Card>
      ) : sections.map((s) => {
        const sq = visibleQuestions.filter((q) => q.section_id === s.id);
        if (sq.length === 0) return null;
        return (
          <Card key={s.id}>
            <CardHeader>
              <CardTitle className="text-base">{s.title}</CardTitle>
              {s.description ? <CardDescription>{s.description}</CardDescription> : null}
            </CardHeader>
            <CardContent className="space-y-4">
              {sq.map((q) => {
                const a = answers[q.id] ?? {};
                const showRating = q.question_type !== "text";
                const showComment = q.question_type !== "rating";
                return (
                  <div key={q.id} className="space-y-2 border-b pb-3 last:border-b-0">
                    <Label className="text-sm">
                      {q.prompt}
                      {q.is_required ? <span className="text-destructive"> *</span> : null}
                    </Label>
                    {showRating ? (
                      <div className="flex items-center gap-2">
                        <Slider
                          value={[a.rating ?? 0]}
                          onValueChange={(v) => setAnswers((cur) => ({ ...cur, [q.id]: { ...cur[q.id], rating: v[0] } }))}
                          max={5}
                          step={1}
                          disabled={!editable}
                          className="max-w-xs"
                        />
                        <span className="text-sm tabular-nums w-8">{a.rating ?? 0}/5</span>
                      </div>
                    ) : null}
                    {showComment ? (
                      <Textarea
                        rows={3}
                        value={a.comment ?? ""}
                        onChange={(e) => setAnswers((cur) => ({ ...cur, [q.id]: { ...cur[q.id], comment: e.target.value } }))}
                        disabled={!editable}
                        placeholder="Your comment…"
                      />
                    ) : null}
                    {editable ? (
                      <Button
                        size="sm"
                        variant="outline"
                        onClick={() => saveResponse.mutate({ question_id: q.id, rating: a.rating ?? null, comment: a.comment ?? null })}
                      >Save</Button>
                    ) : null}
                  </div>
                );
              })}
            </CardContent>
          </Card>
        );
      })}

      {/* Reviewer summary + submit */}
      {(editable || review.status === "submitted" || review.status === "signed_off" || review.status === "acknowledged") ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Overall</CardTitle></CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Overall rating ({overall}/5)</Label>
              <Slider value={[overall]} onValueChange={(v) => setOverall(v[0])} max={5} step={1} disabled={!editable} className="mt-2 max-w-xs" />
            </div>
            <div className="grid md:grid-cols-2 gap-3">
              <div>
                <Label className="text-xs">Strengths</Label>
                <Textarea rows={3} value={strengths} onChange={(e) => setStrengths(e.target.value)} disabled={!editable} />
              </div>
              <div>
                <Label className="text-xs">Areas for development</Label>
                <Textarea rows={3} value={devAreas} onChange={(e) => setDevAreas(e.target.value)} disabled={!editable} />
              </div>
            </div>
            <div>
              <Label className="text-xs">Summary</Label>
              <Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} disabled={!editable} />
            </div>
            {editable ? (
              <Button
                onClick={() => submitReview.mutate({ overall_rating: overall, summary, strengths, development_areas: devAreas })}
                disabled={submitReview.isPending}
              ><Send className="h-4 w-4 mr-1" /> Submit review</Button>
            ) : null}
          </CardContent>
        </Card>
      ) : null}

      {/* Sign-off (calibration) */}
      {canSignOff ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base flex items-center gap-2"><ShieldCheck className="h-4 w-4" /> Calibration & sign-off</CardTitle>
            <CardDescription>Adjust the final rating after calibration and lock the review.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            <div>
              <Label className="text-xs">Final rating ({finalRating}/5)</Label>
              <Slider value={[finalRating]} onValueChange={(v) => setFinalRating(v[0])} max={5} step={1} className="mt-2 max-w-xs" />
            </div>
            <div>
              <Label className="text-xs">Calibration notes</Label>
              <Textarea rows={3} value={calibrationNotes} onChange={(e) => setCalibrationNotes(e.target.value)} />
            </div>
            <Button onClick={() => signOff.mutate({ final_rating: finalRating, calibration_notes: calibrationNotes })} disabled={signOff.isPending}>
              <ShieldCheck className="h-4 w-4 mr-1" /> Sign off
            </Button>
          </CardContent>
        </Card>
      ) : null}

      {/* Acknowledge */}
      {canAcknowledge ? (
        <Card>
          <CardHeader><CardTitle className="text-base">Acknowledge your review</CardTitle><CardDescription>This confirms you've read the final rating and notes.</CardDescription></CardHeader>
          <CardContent>
            <Button onClick={() => acknowledge.mutate()} disabled={acknowledge.isPending}><CheckCircle2 className="h-4 w-4 mr-1" /> Acknowledge</Button>
          </CardContent>
        </Card>
      ) : null}

      {review.status === "acknowledged" ? (
        <Card><CardContent className="py-4 text-sm text-muted-foreground flex items-center gap-2"><CheckCircle2 className="h-4 w-4 text-primary" /> Acknowledged on {new Date(review.acknowledged_at!).toLocaleString()}.</CardContent></Card>
      ) : null}
    </div>
  );
}
