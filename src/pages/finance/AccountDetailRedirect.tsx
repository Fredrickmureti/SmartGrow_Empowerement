/**
 * AccountDetailRedirect
 *
 * Per-record route `/finance/accounts/:id` that deep-links into the
 * AccountRegister page (single-account ledger view with running balance).
 * The register already accepts `?account_id=...`; this wrapper turns the
 * shareable RESTful URL into the existing query-string flow so we don't
 * fork the AccountRegister implementation.
 */

import { Navigate, useParams } from "react-router-dom";

export default function AccountDetailRedirect() {
  const { id } = useParams<{ id: string }>();
  if (!id) return <Navigate to="/finance/accounts" replace />;
  return <Navigate to={`/finance/accounts/register?account_id=${id}`} replace />;
}
