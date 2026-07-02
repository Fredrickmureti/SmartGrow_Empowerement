import { normalizeError } from "@/services/resilience";
/**
 * BusinessLogoUpload — per-company logo uploader.
 *
 * Architectural notes (Odoo res.company model):
 *   - The logo is a property of the legal/accounting entity (`businesses`),
 *     NOT of the workspace/tenant (`organizations`).
 *   - Every customer-facing surface (invoices, bills, receipts, statements,
 *     payslips, PDFs, emails) renders the logo of the company that owns the
 *     document via `useDocumentBranding(business_id)`.
 *   - Storage path is `{org_id}/business/{business_id}/logo.{ext}`. The
 *     bucket's existing RLS keys on `(storage.foldername(name))[1] = org_id`,
 *     so this nested layout works without policy changes and gives each
 *     company an isolated folder.
 */
import { useState, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Loader2, Upload, Trash2, ImageIcon } from "lucide-react";

interface BusinessLogoUploadProps {
  organizationId: string;
  businessId: string;
  currentLogoUrl: string | null;
  onLogoChange?: (url: string | null) => void;
  disabled?: boolean;
  /** Compact variant for use inside a larger company-edit form. */
  compact?: boolean;
}

const ALLOWED_TYPES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
  "image/svg+xml",
];
const MAX_BYTES = 2 * 1024 * 1024;

export function BusinessLogoUpload({
  organizationId,
  businessId,
  currentLogoUrl,
  onLogoChange,
  disabled = false,
  compact = false,
}: BusinessLogoUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const [isDeleting, setIsDeleting] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const { toast } = useToast();
  const queryClient = useQueryClient();

  const folder = `${organizationId}/business/${businessId}`;

  /**
   * Invalidate every cache that derives branding from this business so
   * sidebar chrome, document previews, and edge-function-generated PDFs
   * all pick up the new logo on the next render.
   */
  const invalidateBranding = () => {
    queryClient.invalidateQueries({ queryKey: ["document-branding", businessId] });
    queryClient.invalidateQueries({ queryKey: ["businesses"] });
    queryClient.invalidateQueries({ queryKey: ["session"] });
  };

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!ALLOWED_TYPES.includes(file.type)) {
      toast({
        title: "Invalid file type",
        description: "Please upload a JPG, PNG, GIF, WebP, or SVG image.",
        variant: "destructive",
      });
      return;
    }

    if (file.size > MAX_BYTES) {
      toast({
        title: "File too large",
        description: "Logo must be less than 2MB.",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);
    try {
      const fileExt = (file.name.split(".").pop() || "png").toLowerCase();
      const fileName = `${folder}/logo.${fileExt}`;

      // Clean any other extensions left over from a previous upload, so we
      // don't accumulate orphaned files when the format changes.
      const { data: existing } = await supabase.storage
        .from("organization-assets")
        .list(folder);
      const stale = (existing || [])
        .filter((f) => f.name.startsWith("logo.") && f.name !== `logo.${fileExt}`)
        .map((f) => `${folder}/${f.name}`);
      if (stale.length > 0) {
        await supabase.storage.from("organization-assets").remove(stale);
      }

      const { error: uploadError } = await supabase.storage
        .from("organization-assets")
        .upload(fileName, file, {
          cacheControl: "3600",
          upsert: true,
          contentType: file.type,
        });
      if (uploadError) throw uploadError;

      const {
        data: { publicUrl },
      } = supabase.storage.from("organization-assets").getPublicUrl(fileName);
      const urlWithCacheBuster = `${publicUrl}?t=${Date.now()}`;

      const { error: updateError } = await supabase
        .from("businesses")
        .update({ logo_url: urlWithCacheBuster, updated_at: new Date().toISOString() } as any)
        .eq("id", businessId);
      if (updateError) throw updateError;

      onLogoChange?.(urlWithCacheBuster);
      invalidateBranding();
      toast({
        title: "Logo uploaded",
        description: "Customer-facing documents will use this logo immediately.",
      });
    } catch (error: any) {
      console.error("Business logo upload error:", error);
      toast({
        title: "Upload failed",
        description: normalizeError(error).message || "Failed to upload logo.",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  const handleDeleteLogo = async () => {
    if (!currentLogoUrl) return;
    setIsDeleting(true);
    try {
      const { data: files } = await supabase.storage
        .from("organization-assets")
        .list(folder);
      const logoFiles = (files || [])
        .filter((f) => f.name.startsWith("logo"))
        .map((f) => `${folder}/${f.name}`);
      if (logoFiles.length > 0) {
        await supabase.storage.from("organization-assets").remove(logoFiles);
      }

      const { error: updateError } = await supabase
        .from("businesses")
        .update({ logo_url: null, updated_at: new Date().toISOString() } as any)
        .eq("id", businessId);
      if (updateError) throw updateError;

      onLogoChange?.(null);
      invalidateBranding();
      toast({
        title: "Logo removed",
        description: "Documents will render without a logo until a new one is uploaded.",
      });
    } catch (error: any) {
      console.error("Business logo delete error:", error);
      toast({
        title: "Delete failed",
        description: normalizeError(error).message || "Failed to delete logo.",
        variant: "destructive",
      });
    } finally {
      setIsDeleting(false);
    }
  };

  return (
    <div className="space-y-3">
      {!compact && <Label>Company Logo</Label>}
      <div className="flex items-start gap-4">
        <div className="h-20 w-20 sm:h-24 sm:w-24 rounded-lg border-2 border-dashed border-muted-foreground/25 flex items-center justify-center bg-muted/50 overflow-hidden shrink-0">
          {currentLogoUrl ? (
            <img
              src={currentLogoUrl}
              alt="Company logo"
              className="h-full w-full object-contain"
            />
          ) : (
            <ImageIcon className="h-8 w-8 text-muted-foreground/50" />
          )}
        </div>

        <div className="flex flex-col gap-2 min-w-0 flex-1">
          <input
            ref={fileInputRef}
            type="file"
            accept="image/jpeg,image/png,image/gif,image/webp,image/svg+xml"
            onChange={handleFileSelect}
            className="hidden"
            disabled={disabled || isUploading}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={disabled || isUploading}
            >
              {isUploading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Uploading…
                </>
              ) : (
                <>
                  <Upload className="mr-2 h-4 w-4" />
                  {currentLogoUrl ? "Change logo" : "Upload logo"}
                </>
              )}
            </Button>
            {currentLogoUrl && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={handleDeleteLogo}
                disabled={disabled || isDeleting}
                className="text-destructive hover:text-destructive hover:bg-destructive/10"
              >
                {isDeleting ? (
                  <>
                    <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                    Removing…
                  </>
                ) : (
                  <>
                    <Trash2 className="mr-2 h-4 w-4" />
                    Remove
                  </>
                )}
              </Button>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            JPG, PNG, GIF, WebP, or SVG. Max 2MB. Appears on this company's invoices, bills, receipts, statements, and PDFs.
          </p>
        </div>
      </div>
    </div>
  );
}
