/**
 * AdminMfaSetup page — now a simple redirect.
 * MFA enrollment is handled inline by AdminProtectedRoute via AdminInlineMfaSetup.
 * This page exists only for backward compatibility with any bookmarked URLs.
 */
import { Navigate } from "react-router-dom";

export default function AdminMfaSetup() {
  return <Navigate to="/admin-management" replace />;
}
