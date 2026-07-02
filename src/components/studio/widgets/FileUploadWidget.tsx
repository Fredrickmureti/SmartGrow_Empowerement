import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { toast } from "sonner";
import { Upload, X, FileIcon, Loader2, Download, ExternalLink } from "lucide-react";
import { EntityFieldConfig } from "@/hooks/useEntityFields";
import { normalizeError } from "@/services/resilience";

interface FileUploadWidgetProps {
  field: EntityFieldConfig;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

const MAX_FILE_SIZE = 10 * 1024 * 1024; // 10MB

function getFileName(url: string): string {
  try {
    const parts = url.split("/");
    const rawName = parts[parts.length - 1];
    // Remove timestamp prefix pattern like "1234567890_"
    return decodeURIComponent(rawName.replace(/^\d+_/, ""));
  } catch {
    return "file";
  }
}

function getFileExtension(name: string): string {
  return name.split(".").pop()?.toLowerCase() || "";
}

export function FileUploadWidget({ field, value, onChange, disabled }: FileUploadWidgetProps) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [isUploading, setIsUploading] = useState(false);
  const [dragOver, setDragOver] = useState(false);

  const handleFileSelect = async (file: File) => {
    if (file.size > MAX_FILE_SIZE) {
      toast.error("File too large", { description: "Maximum file size is 10MB." });
      return;
    }

    setIsUploading(true);
    try {
      const fileExt = file.name.split(".").pop()?.toLowerCase() || "bin";
      const fileName = `${field.entity_type}/${field.field_key}/${Date.now()}_${file.name}`;

      const { data, error } = await supabase.storage
        .from("custom-field-attachments")
        .upload(fileName, file, { cacheControl: "3600", upsert: false });

      if (error) throw error;

      const { data: urlData } = supabase.storage
        .from("custom-field-attachments")
        .getPublicUrl(data.path);

      onChange(urlData.publicUrl);
      toast.success("File uploaded successfully");
    } catch (error: any) {
      console.error("Upload error:", error);
      toast.error("Upload failed", { description: normalizeError(error).message });
    } finally {
      setIsUploading(false);
    }
  };

  const handleDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragOver(false);
    const file = e.dataTransfer.files[0];
    if (file) handleFileSelect(file);
  };

  const handleRemove = () => {
    onChange(null);
  };

  if (value) {
    const fileName = getFileName(value);
    const ext = getFileExtension(fileName);
    const isImage = ["jpg", "jpeg", "png", "gif", "webp", "svg"].includes(ext);

    return (
      <div className="rounded-lg border bg-muted/30 p-3 space-y-2">
        {isImage && (
          <div className="relative w-full max-h-40 rounded-md overflow-hidden bg-muted">
            <img
              src={value}
              alt={fileName}
              className="w-full h-full object-contain max-h-40"
              onError={(e) => { (e.target as HTMLImageElement).style.display = "none"; }}
            />
          </div>
        )}
        <div className="flex items-center gap-2">
          <FileIcon className="h-4 w-4 text-muted-foreground shrink-0" />
          <span className="text-sm truncate flex-1" title={fileName}>{fileName}</span>
          <div className="flex gap-1 shrink-0">
            <Button
              type="button"
              variant="ghost"
              size="icon"
              className="h-7 w-7"
              asChild
            >
              <a href={value} target="_blank" rel="noopener noreferrer">
                <ExternalLink className="h-3.5 w-3.5" />
              </a>
            </Button>
            {!disabled && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                className="h-7 w-7 text-destructive hover:text-destructive"
                onClick={handleRemove}
              >
                <X className="h-3.5 w-3.5" />
              </Button>
            )}
          </div>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`
        border-2 border-dashed rounded-lg p-4 text-center cursor-pointer
        transition-colors duration-200
        ${dragOver ? "border-primary bg-primary/5" : "border-muted-foreground/25 hover:border-primary/50"}
        ${isUploading || disabled ? "pointer-events-none opacity-50" : ""}
      `}
      onClick={() => fileInputRef.current?.click()}
      onDrop={handleDrop}
      onDragOver={(e) => { e.preventDefault(); setDragOver(true); }}
      onDragLeave={() => setDragOver(false)}
    >
      <input
        ref={fileInputRef}
        type="file"
        className="hidden"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) handleFileSelect(file);
          e.target.value = "";
        }}
        disabled={disabled}
      />
      {isUploading ? (
        <div className="flex flex-col items-center gap-2 py-2">
          <Loader2 className="h-6 w-6 animate-spin text-primary" />
          <p className="text-xs text-muted-foreground">Uploading...</p>
        </div>
      ) : (
        <div className="flex flex-col items-center gap-1 py-2">
          <Upload className="h-6 w-6 text-muted-foreground" />
          <p className="text-sm font-medium">Drop file here or click to browse</p>
          <p className="text-xs text-muted-foreground">Max 10MB</p>
        </div>
      )}
    </div>
  );
}
