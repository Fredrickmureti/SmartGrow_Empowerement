/**
 * AccountCreatePage — routed create surface at `/finance/accounts/new`.
 * Composes `AccountForm` on `RecordFormShell`. Replaces the legacy
 * inline `Dialog` previously mounted from `src/pages/Accounts.tsx`.
 */
import { AccountForm } from "./AccountForm";

export default function AccountCreatePage() {
  return <AccountForm mode="create" />;
}