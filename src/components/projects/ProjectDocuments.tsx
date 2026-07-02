/**
 * ProjectDocuments — drag-drop upload + list for a project's documents.
 *
 * Bucket: project-documents · path: {organization_id}/{project_id}/<file>
 * RLS on storage.objects mirrors can_access_project, so visibility matches
 * the rest of the project workspace automatically.
 */
import { useRef, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Upload, FileText, Download, Trash2, FileImage, FileArchive } from "lucide-react";
import { format } from "date-fns";
import { useProjectDocuments, ProjectDocument } from "@/hooks/projects";

interface ProjectDocumentsProps {
  projectId: string;
}

function bytes(n: number | null): string {
  if (!n) return "—";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

function iconFor(mime: string | null) {
  if (!mime) return FileText;
  if (mime.startsWith("image/")) return FileImage;
  if (mime.includes("zip") || mime.includes("archive")) return FileArchive;
  return FileText;
}

export function ProjectDocuments({ projectId }: ProjectDocumentsProps) {
  const { documents, isLoading, upload, remove, getSignedUrl } =
    useProjectDocuments(projectId);
  const [isDragging, setIsDragging] = useState(false);
  const [uploading, setUploading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  const handleFiles = async (files: FileList | null) => {
    if (!files || files.length === 0) return;
    setUploading(true);
    try {
      for (const f of Array.from(files)) {
        await upload(f);
      }
    } finally {
      setUploading(false);
    }
  };

  const handleDownload = async (doc: ProjectDocument) => {
    const url = await getSignedUrl(doc);
    if (url) window.open(url, "_blank", "noopener,noreferrer");
  };

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Project Documents</CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Drop zone */}
        <div
          onDragOver={(e) => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragging(false);
            void handleFiles(e.dataTransfer.files);
          }}
          className={`rounded-lg border-2 border-dashed transition-colors p-6 text-center cursor-pointer ${
            isDragging ? "border-primary bg-primary/5" : "border-border hover:bg-muted/30"
          }`}
          onClick={() => inputRef.current?.click()}
        >
          <Upload className="h-6 w-6 mx-auto mb-2 text-muted-foreground" />
          <p className="text-sm text-muted-foreground">
            {uploading ? "Uploading…" : "Drag and drop files here, or click to browse"}
          </p>
          <p className="text-xs text-muted-foreground mt-1">
            Up to 50 MB per file · PDF, Office, images, archives
          </p>
          <input
            ref={inputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(e) => void handleFiles(e.target.files)}
          />
        </div>

        {/* Documents list */}
        {isLoading ? (
          <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
        ) : documents.length === 0 ? (
          <p className="text-sm text-muted-foreground text-center py-4">
            No documents uploaded yet.
          </p>
        ) : (
          <div className="divide-y border rounded-md">
            {documents.map((doc) => {
              const Icon = iconFor(doc.mime_type);
              return (
                <div key={doc.id} className="flex items-center gap-3 p-3">
                  <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium truncate">{doc.name}</div>
                    <div className="text-xs text-muted-foreground">
                      {bytes(doc.size_bytes)} ·{" "}
                      {format(new Date(doc.created_at), "MMM d, yyyy")}
                    </div>
                  </div>
                  <Button
                    size="sm"
                    variant="ghost"
                    onClick={() => handleDownload(doc)}
                    aria-label="Download"
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    className="text-destructive hover:text-destructive"
                    onClick={() => {
                      if (confirm(`Delete ${doc.name}?`)) void remove(doc);
                    }}
                    aria-label="Delete"
                  >
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
