/**
 * AdminGroupEditPage — `/admin-management/groups/:id/edit`.
 * Loads the group from `usePlatformGroups` and hands it to the shared
 * `AdminGroupForm`.
 */
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { LoadingState } from "@/design-system";
import { usePlatformGroups } from "@/hooks/usePlatformGroups";
import { AdminGroupForm } from "./AdminGroupForm";

export default function AdminGroupEditPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { groups, isLoading, fetchGroups } = usePlatformGroups();

  useEffect(() => {
    fetchGroups();
  }, [fetchGroups]);

  if (isLoading && groups.length === 0) {
    return <LoadingState label="Loading group..." />;
  }

  const group = groups.find((g) => g.id === id) ?? null;

  if (!group) {
    // Group not found; bounce to list.
    navigate("/admin-management/groups", { replace: true });
    return null;
  }

  return <AdminGroupForm mode="edit" group={group} />;
}