import { AuthLayout } from "@/components/auth/AuthLayout";
import { EnhancedLoginForm } from "@/components/auth/EnhancedLoginForm";

export default function Login() {
  return (
    <AuthLayout
      title="Welcome back"
      subtitle="Sign in to your account to continue"
    >
      <EnhancedLoginForm />
    </AuthLayout>
  );
}
