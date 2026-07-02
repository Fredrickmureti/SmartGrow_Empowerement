/**
 * My Reviews — employee landing for review assignments. Shows two lists:
 *  1. Reviews I need to fill in (I'm the reviewer — typically my self-review,
 *     or manager reviews if I manage people).
 *  2. Reviews about me — submitted/signed-off, pending acknowledgement.
 */
import { useMemo } from "react";
import { Link } from "react-router-dom";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useReviews, type ReviewStatus } from "@/hooks/useReviews";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { ClipboardList, ChevronRight, Inbox } from "lucide-react";

const STATUS_VARIANT: Record<ReviewStatus, "default" | "secondary" | "outline" | "destructive"> = {
  draft: "outline", in_progress: "secondary", submitted: "default",
  calibrated: "secondary", signed_off: "default", acknowledged: "default", cancelled: "destructive",
};

export default function MyReviews() {
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const { reviews: toFill, isLoading: l1 } = useReviews({ reviewerUserId: user?.id });
  const { reviews: aboutMe, isLoading: l2 } = useReviews({ employeeId: currentEmployee?.id });

  const otherAboutMe = useMemo(
    () => aboutMe.filter((r) => r.reviewer_user_id !== user?.id),
    [aboutMe, user?.id],
  );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold flex items-center gap-2"><ClipboardList className="h-5 w-5" /> My reviews</h1>
        <p className="text-sm text-muted-foreground">Reviews you need to complete, plus reviews about you.</p>
      </div>

      <section>
        <h2 className="text-sm font-semibold mb-2">Reviews to complete</h2>
        {l1 ? <p className="text-sm text-muted-foreground">Loading…</p> :
         toFill.length === 0 ? (
          <Card><CardContent className="py-8 text-center text-sm text-muted-foreground flex flex-col items-center gap-2">
            <Inbox className="h-8 w-8 text-muted-foreground" />
            <p>Nothing to fill in right now.</p>
          </CardContent></Card>
        ) : (
          <div className="grid gap-2">
            {toFill.map((r) => (
              <Link key={r.id} to={`/me/talent/reviews/${r.id}`} className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-accent">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium capitalize">{r.review_type.replace(/_/g, " ")} review</p>
                  <p className="text-xs text-muted-foreground">{r.due_at ? `Due ${new Date(r.due_at).toLocaleDateString()}` : "No due date"}</p>
                </div>
                <Badge variant={STATUS_VARIANT[r.status]}>{r.status.replace(/_/g, " ")}</Badge>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </section>

      <section>
        <h2 className="text-sm font-semibold mb-2">About me</h2>
        {l2 ? <p className="text-sm text-muted-foreground">Loading…</p> :
         otherAboutMe.length === 0 ? (
          <Card><CardContent className="py-6 text-center text-sm text-muted-foreground">No reviews about you yet.</CardContent></Card>
        ) : (
          <div className="grid gap-2">
            {otherAboutMe.map((r) => (
              <Link key={r.id} to={`/me/talent/reviews/${r.id}`} className="flex items-center gap-3 rounded-md border px-3 py-2 hover:bg-accent">
                <div className="flex-1 min-w-0">
                  <p className="text-sm font-medium capitalize">{r.review_type.replace(/_/g, " ")} review</p>
                  <p className="text-xs text-muted-foreground">{r.submitted_at ? `Submitted ${new Date(r.submitted_at).toLocaleDateString()}` : "Pending"}</p>
                </div>
                <Badge variant={STATUS_VARIANT[r.status]}>{r.status.replace(/_/g, " ")}</Badge>
                <ChevronRight className="h-4 w-4 text-muted-foreground" />
              </Link>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
