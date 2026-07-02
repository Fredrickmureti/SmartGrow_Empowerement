/**
 * Review Detail (HR / Manager / Reviewer view).
 *
 * Reused for both the reviewer (filling in their assigned review) and for HR
 * (read-only oversight + sign-off). Same component, gated actions by status
 * and by whether the current user is the reviewer.
 */
import { Link, useParams } from "react-router-dom";
import { useReview } from "@/hooks/useReviews";
import { ReviewFormBody } from "@/components/talent/ReviewFormBody";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function ReviewDetailPage() {
  const { reviewId } = useParams();
  return (
    <div className="space-y-3">
      <Button asChild variant="ghost" size="sm"><Link to="/hr/talent/reviews"><ArrowLeft className="h-4 w-4 mr-1" /> All reviews</Link></Button>
      <ReviewFormBody reviewId={reviewId} backHref="/hr/talent/reviews" />
    </div>
  );
}
