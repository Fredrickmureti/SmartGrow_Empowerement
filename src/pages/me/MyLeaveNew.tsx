/**
 * MyLeaveNew — routed `/me/leave/new` surface for filing a leave request.
 *
 * The request UI itself (`LeaveRequestForm`) is a `WorkflowSheet`; this
 * page just mounts it in open state and navigates back to `/me/leave`
 * when the sheet closes. Routing the flow this way makes the request
 * form URL-addressable (deep-linkable from notifications and mobile
 * shortcuts) and gives it the same navigation semantics as every other
 * "create" surface on the platform.
 */
import { useNavigate } from "react-router-dom";
import { LeaveRequestForm } from "@/components/leave/LeaveRequestForm";

export default function MyLeaveNew() {
  const navigate = useNavigate();
  return (
    <LeaveRequestForm
      open
      onOpenChange={(open) => {
        if (!open) navigate("/me/leave");
      }}
    />
  );
}
