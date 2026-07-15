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
import { PageHeader, PageBody, LoadingState, EmptyState } from "@/design-system";

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
    <>
      <PageHeader title="My reviews" description="Reviews you need to complete, plus reviews about you." />
      <PageBody>
      <section>
        <h2 className="text-sm font-semibold mb-2">Reviews to complete</h2>
        {l1 ? <LoadingState rows={2} /> :
         toFill.length === 0 ? (
          <EmptyState icon={Inbox} title="Nothing to fill in right now" />
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
        {l2 ? <LoadingState rows={2} /> :
         otherAboutMe.length === 0 ? (
          <EmptyState icon={ClipboardList} title="No reviews about you yet" />
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
      </PageBody>
    </>
  );
}
