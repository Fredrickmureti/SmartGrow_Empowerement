/**
 * AccountEditPage — routed edit surface at
 * `/finance/accounts/:id/edit`. Loads the target account from
 * `useAccounts` and composes `AccountForm` on `RecordFormShell`.
 */
import { Navigate, useParams } from "react-router-dom";
import { useAccounts } from "@/hooks/useAccounts";
import { AccountForm } from "./AccountForm";

export default function AccountEditPage() {
  const { id } = useParams<{ id: string }>();
  const { accounts, isLoading } = useAccounts();

  if (!id) return <Navigate to="/finance/accounts" replace />;
  if (isLoading) return null;

  const account = accounts.find((a) => a.id === id) ?? null;
  if (!account) return <Navigate to="/finance/accounts" replace />;

  return <AccountForm mode="edit" account={account} />;
}