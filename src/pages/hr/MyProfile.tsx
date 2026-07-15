/**
 * MyProfile (legacy `/hr/my-profile`) — back-compat redirect to
 * `/me/profile`, which is now the canonical ESS profile page rendered
 * inside `MePortalLayout`.
 *
 * The previous implementation redirected to `/hr/employees/:id`, an
 * admin route the portal guard bounced portal users away from — the
 * root cause of the "profile navigates back to /me" bug.
 */
import { Navigate } from "react-router-dom";

export default function MyProfile() {
  return <Navigate to="/me/profile" replace />;
}
