import { useState, useRef } from "react";
import { supabase } from "@/integrations/supabase/client";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Camera, Loader2 } from "lucide-react";
import { toast } from "sonner";

interface EmployeeAvatarUploadProps {
  employeeId: string;
  organizationId: string;
  currentAvatarUrl: string | null;
  firstName: string;
  lastName: string;
  canEdit: boolean;
  onAvatarChange: (url: string) => void;
  size?: "sm" | "lg";
}

export function EmployeeAvatarUpload({
  employeeId,
  organizationId,
  currentAvatarUrl,
  firstName,
  lastName,
  canEdit,
  onAvatarChange,
  size = "lg",
}: EmployeeAvatarUploadProps) {
  const [isUploading, setIsUploading] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);

  const initials = `${firstName?.[0] || ""}${lastName?.[0] || ""}`.toUpperCase();
  const sizeClass = size === "lg" ? "h-24 w-24 text-2xl" : "h-12 w-12 text-sm";

  const handleFileSelect = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      toast.error("Please select an image file");
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      toast.error("Image must be less than 5MB");
      return;
    }

    setIsUploading(true);
    try {
      const ext = file.name.split(".").pop();
      const filePath = `${organizationId}/${employeeId}/avatar.${ext}`;

      const { error: uploadError } = await supabase.storage
        .from("employee-avatars")
        .upload(filePath, file, { upsert: true });

      if (uploadError) throw uploadError;

      const { data: urlData } = supabase.storage
        .from("employee-avatars")
        .getPublicUrl(filePath);

      const avatarUrl = `${urlData.publicUrl}?t=${Date.now()}`;

      // Update employee record
      const { error: updateError } = await supabase
        .from("employees")
        .update({ avatar_url: avatarUrl })
        .eq("id", employeeId);

      if (updateError) throw updateError;

      onAvatarChange(avatarUrl);
      toast.success("Profile photo updated");
    } catch (error: any) {
      console.error("Avatar upload error:", error);
      toast.error("Failed to upload photo");
    } finally {
      setIsUploading(false);
      if (fileInputRef.current) fileInputRef.current.value = "";
    }
  };

  return (
    <div className="relative group">
      <Avatar className={`${sizeClass} border-2 border-border`}>
        <AvatarImage src={currentAvatarUrl || undefined} alt={`${firstName} ${lastName}`} />
        <AvatarFallback className="bg-primary/10 text-primary font-semibold">
          {initials}
        </AvatarFallback>
      </Avatar>

      {canEdit && (
        <>
          <input
            ref={fileInputRef}
            type="file"
            accept="image/*"
            className="hidden"
            onChange={handleFileSelect}
          />
          <Button
            variant="secondary"
            size="icon"
            className="absolute -bottom-1 -right-1 h-8 w-8 rounded-full shadow-md opacity-0 group-hover:opacity-100 transition-opacity"
            onClick={() => fileInputRef.current?.click()}
            disabled={isUploading}
          >
            {isUploading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Camera className="h-4 w-4" />
            )}
          </Button>
        </>
      )}
    </div>
  );
}
