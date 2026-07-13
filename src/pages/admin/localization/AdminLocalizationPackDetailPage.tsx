/**
 * AdminLocalizationPackDetailPage — workspace at
 * `/admin-management/localization-packs/:id`. Replaces the legacy
 * 1100 px right-side `<Sheet>` from `AdminLocalizationPacks.tsx` and
 * mounts the shared `<PackEditorShell />` on `AdminRecordPage` so pack
 * maintenance feels like every other business record in the ERP.
 */
import { useNavigate, useParams } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { AdminRecordPage } from "@/apps/platform-admin";
import { RecordHeader, LoadingState, StatusBadge } from "@/design-system";
import { Button } from "@/components/ui/button";
import { adminFrom } from "@/lib/adminClient";
import { PackEditorShell } from "@/features/localization";
import { ArrowLeft, Package } from "lucide-react";

interface LocalizationPack {
  id: string;
  country_code: string;
  name: string;
  description: string | null;
  version: string;
  is_active: boolean;
  is_published: boolean;
}

const LIST_PATH = "/admin-management/localization-packs";

export default function AdminLocalizationPackDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();

  const { data: pack, isLoading } = useQuery({
    queryKey: ["admin-localization-pack", id],
    enabled: !!id,
    queryFn: async () => {
      const { data, error } = await adminFrom("localization_packs")
        .select("*")
        .eq("id", id)
        .single();
      if (error) throw error;
      return data as LocalizationPack;
    },
  });

  if (isLoading) return <LoadingState />;
  if (!pack) {
    navigate(LIST_PATH, { replace: true });
    return null;
  }

  return (
    <AdminRecordPage
      header={
        <RecordHeader
          eyebrow="Localization pack"
          title={
            <span className="inline-flex items-center gap-2">
              <Package className="h-5 w-5" />
              {pack.name}
            </span>
          }
          docNumber={`v${pack.version}`}
          status={
            <StatusBadge
              status={pack.is_published ? "success" : "muted"}
              label={pack.is_published ? "Published" : "Draft"}
            />
          }
          meta={
            <>
              <span>{pack.country_code}</span>
              {pack.description && <span>· {pack.description}</span>}
            </>
          }
          actions={
            <Button
              variant="outline"
              size="sm"
              onClick={() => navigate(LIST_PATH)}
            >
              <ArrowLeft className="h-3.5 w-3.5 mr-1.5" />
              Back to packs
            </Button>
          }
        />
      }
    >
      <PackEditorShell mode="admin" packId={pack.id} />
    </AdminRecordPage>
  );
}