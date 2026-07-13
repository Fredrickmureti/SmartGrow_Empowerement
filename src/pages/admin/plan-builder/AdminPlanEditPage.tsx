import { useNavigate, useParams } from "react-router-dom";
import { LoadingState } from "@/design-system";
import { useSubscriptionPlans } from "@/hooks/useSubscriptionPlans";
import { AdminPlanForm } from "./AdminPlanForm";

export default function AdminPlanEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { plans, isLoading } = useSubscriptionPlans();

  if (isLoading) return <LoadingState />;
  const plan = plans.find((p) => p.id === id) ?? null;
  if (!plan) {
    navigate("/admin-management/plan-builder", { replace: true });
    return null;
  }
  return <AdminPlanForm mode="edit" plan={plan} />;
}