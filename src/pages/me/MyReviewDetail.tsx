/**
 * My Review Detail — employee-facing review surface (self review fill-in,
 * or acknowledging a manager review). Wraps the shared ReviewFormBody.
 */
import { Link, useParams } from "react-router-dom";
import { ReviewFormBody } from "@/components/talent/ReviewFormBody";
import { Button } from "@/components/ui/button";
import { ArrowLeft } from "lucide-react";
import { PageHeader, PageBody } from "@/design-system";

export default function MyReviewDetail() {
  const { reviewId } = useParams();
  return (
    <>
      <PageHeader
        title="Review"
        actions={<Button asChild variant="ghost" size="sm"><Link to="/me/talent/reviews"><ArrowLeft className="h-4 w-4 mr-1" /> Back to my reviews</Link></Button>}
      />
      <PageBody>
        <ReviewFormBody reviewId={reviewId} backHref="/me/talent/reviews" />
      </PageBody>
    </>
  );
}
