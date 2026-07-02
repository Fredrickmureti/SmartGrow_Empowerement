/**
 * My Review Detail — employee-facing review surface (self review fill-in,
 * or acknowledging a manager review). Wraps the shared ReviewFormBody.
 */
import { Link, useParams } from "react-router-dom";
import { ReviewFormBody } from "@/components/talent/ReviewFormBody";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";

export default function MyReviewDetail() {
  const { reviewId } = useParams();
  return (
    <div className="space-y-3">
      <Button asChild variant="ghost" size="sm"><Link to="/me/talent/reviews"><ArrowLeft className="h-4 w-4 mr-1" /> Back to my reviews</Link></Button>
      <ReviewFormBody reviewId={reviewId} backHref="/me/talent/reviews" />
    </div>
  );
}
