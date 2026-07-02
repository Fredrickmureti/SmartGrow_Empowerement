import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { useToast } from "@/hooks/use-toast";
import { Upload, X, FileImage, Loader2, ExternalLink } from "lucide-react";
import { cn } from "@/lib/utils";
import { normalizeError } from "@/services/resilience";

interface ReceiptUploadProps {
  expenseId?: string;
  currentReceiptUrl?: string | null;
  onUploadComplete: (url: string) => void;
  onRemove?: () => void;
  disabled?: boolean;
}

export function ReceiptUpload({
  expenseId,
  currentReceiptUrl,
  onUploadComplete,
  onRemove,
  disabled = false,
}: ReceiptUploadProps) {
  const { toast } = useToast();
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [previewUrl, setPreviewUrl] = useState<string | null>(currentReceiptUrl || null);

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    // Validate file type
    const validTypes = ["image/jpeg", "image/png", "image/webp", "application/pdf"];
    if (!validTypes.includes(file.type)) {
      toast({
        title: "Invalid file type",
        description: "Please upload an image (JPG, PNG, WebP) or PDF file.",
        variant: "destructive",
      });
      return;
    }

    // Validate file size (max 10MB)
    if (file.size > 10 * 1024 * 1024) {
      toast({
        title: "File too large",
        description: "Maximum file size is 10MB.",
        variant: "destructive",
      });
      return;
    }

    setIsUploading(true);

    try {
      // Generate unique filename
      const fileExt = file.name.split(".").pop();
      const fileName = `${expenseId || crypto.randomUUID()}-${Date.now()}.${fileExt}`;
      const filePath = `receipts/${fileName}`;

      // Upload to Supabase Storage
      const { data, error } = await supabase.storage
        .from("receipts")
        .upload(filePath, file, {
          cacheControl: "3600",
          upsert: false,
        });

      if (error) throw error;

      // Get public URL
      const { data: urlData } = supabase.storage
        .from("receipts")
        .getPublicUrl(data.path);

      const publicUrl = urlData.publicUrl;
      setPreviewUrl(publicUrl);
      onUploadComplete(publicUrl);

      toast({ title: "Receipt uploaded successfully" });
    } catch (error: any) {
      console.error("Upload error:", error);
      toast({
        title: "Upload failed",
        description: normalizeError(error).message || "Failed to upload receipt",
        variant: "destructive",
      });
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleRemove = () => {
    setPreviewUrl(null);
    onRemove?.();
  };

  const isPdf = previewUrl?.toLowerCase().endsWith(".pdf");

  return (
    <div className="space-y-2">
      <input
        ref={fileInputRef}
        type="file"
        accept="image/jpeg,image/png,image/webp,application/pdf"
        onChange={handleFileSelect}
        className="hidden"
        disabled={disabled || isUploading}
      />

      {previewUrl ? (
        <div className="relative border rounded-lg overflow-hidden bg-muted">
          {isPdf ? (
            <div className="flex items-center justify-center p-8">
              <div className="text-center">
                <FileImage className="h-12 w-12 mx-auto text-muted-foreground mb-2" />
                <p className="text-sm text-muted-foreground">PDF Receipt</p>
                <a
                  href={previewUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-sm text-primary hover:underline inline-flex items-center gap-1 mt-2"
                >
                  View PDF <ExternalLink className="h-3 w-3" />
                </a>
              </div>
            </div>
          ) : (
            <div className="relative">
              <img
                src={previewUrl}
                alt="Receipt"
                className="w-full h-48 object-cover"
              />
              <a
                href={previewUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="absolute bottom-2 right-2 bg-background/80 text-xs px-2 py-1 rounded hover:bg-background inline-flex items-center gap-1"
              >
                View full <ExternalLink className="h-3 w-3" />
              </a>
            </div>
          )}
          {!disabled && (
            <Button
              type="button"
              variant="destructive"
              size="icon"
              className="absolute top-2 right-2 h-8 w-8"
              onClick={handleRemove}
            >
              <X className="h-4 w-4" />
            </Button>
          )}
        </div>
      ) : (
        <div
          onClick={() => !disabled && !isUploading && fileInputRef.current?.click()}
          className={cn(
            "border-2 border-dashed rounded-lg p-6 text-center transition-colors",
            disabled || isUploading
              ? "opacity-50 cursor-not-allowed"
              : "cursor-pointer hover:border-primary hover:bg-muted/50"
          )}
        >
          {isUploading ? (
            <div className="flex flex-col items-center">
              <Loader2 className="h-8 w-8 animate-spin text-muted-foreground mb-2" />
              <p className="text-sm text-muted-foreground">Uploading...</p>
            </div>
          ) : (
            <div className="flex flex-col items-center">
              <Upload className="h-8 w-8 text-muted-foreground mb-2" />
              <p className="text-sm font-medium">Upload Receipt</p>
              <p className="text-xs text-muted-foreground mt-1">
                JPG, PNG, WebP, or PDF (max 10MB)
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
