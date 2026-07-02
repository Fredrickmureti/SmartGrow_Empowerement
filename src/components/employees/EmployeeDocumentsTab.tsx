import { useState } from "react";
import { useEmployeeDocuments, DOCUMENT_TYPES, EmployeeDocument } from "@/hooks/useEmployeeDocuments";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { WorkflowSheet, WorkflowSheetSection, WorkflowField } from "@/components/workflow/WorkflowSheet";

import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Textarea } from "@/components/ui/textarea";
import { Upload, Download, Trash2, FileText, Loader2, Plus, CheckCircle2, Eye, X } from "lucide-react";
import { format } from "date-fns";
import { SafePdfViewer } from "@/components/common/SafePdfViewer";

interface EmployeeDocumentsTabProps {
  employeeId: string;
  canEdit?: boolean;
}

const PREVIEWABLE_MIME_TYPES = [
  "application/pdf",
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
];

function isPreviewable(mimeType: string | null): boolean {
  if (!mimeType) return false;
  return PREVIEWABLE_MIME_TYPES.includes(mimeType) || mimeType.startsWith("image/");
}

function isImage(mimeType: string | null): boolean {
  return !!mimeType && mimeType.startsWith("image/");
}

export function EmployeeDocumentsTab({ employeeId, canEdit = false }: EmployeeDocumentsTabProps) {
  const { documents, isLoading, uploadDocument, deleteDocument, downloadDocument, getPreviewUrl } = useEmployeeDocuments(employeeId);
  const [showUpload, setShowUpload] = useState(false);
  const [uploadForm, setUploadForm] = useState({ name: "", type: "other", description: "", file: null as File | null });

  // Preview state
  const [previewDoc, setPreviewDoc] = useState<EmployeeDocument | null>(null);
  const [previewUrl, setPreviewUrl] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);

  const handleUpload = async () => {
    if (!uploadForm.file || !uploadForm.name) return;
    await uploadDocument.mutateAsync({
      file: uploadForm.file,
      documentType: uploadForm.type,
      name: uploadForm.name,
      description: uploadForm.description,
    });
    setShowUpload(false);
    setUploadForm({ name: "", type: "other", description: "", file: null });
  };

  const handlePreview = async (doc: EmployeeDocument) => {
    if (!isPreviewable(doc.mime_type)) {
      // Not previewable — fall back to download
      downloadDocument(doc);
      return;
    }
    setPreviewDoc(doc);
    setPreviewLoading(true);
    const url = await getPreviewUrl(doc);
    setPreviewUrl(url);
    setPreviewLoading(false);
  };

  const closePreview = () => {
    setPreviewDoc(null);
    setPreviewUrl(null);
  };

  if (isLoading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-6 w-6 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <CardTitle className="text-lg">Documents</CardTitle>
        {canEdit && (
          <Button size="sm" onClick={() => setShowUpload(true)}>
            <Plus className="h-4 w-4 mr-1" /> Upload
          </Button>
        )}
      </CardHeader>
      <CardContent>
        {documents.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-8 text-center">
            <FileText className="h-10 w-10 text-muted-foreground mb-3" />
            <p className="text-muted-foreground">No documents uploaded yet.</p>
          </div>
        ) : (
          <div className="space-y-2">
            {documents.map((doc) => (
              <div
                key={doc.id}
                className="flex items-center justify-between p-3 border rounded-lg hover:bg-muted/50 cursor-pointer"
                onClick={() => handlePreview(doc)}
              >
                <div className="flex items-center gap-3 min-w-0">
                  <FileText className="h-5 w-5 text-muted-foreground flex-shrink-0" />
                  <div className="min-w-0">
                    <p className="font-medium text-sm truncate">{doc.name}</p>
                    <div className="flex items-center gap-2 text-xs text-muted-foreground">
                      <Badge variant="outline" className="text-xs">{DOCUMENT_TYPES.find(t => t.value === doc.document_type)?.label || doc.document_type}</Badge>
                      <span>{format(new Date(doc.created_at), "MMM d, yyyy")}</span>
                      {doc.is_verified && (
                        <span className="flex items-center gap-0.5 text-emerald-600">
                          <CheckCircle2 className="h-3 w-3" /> Verified
                        </span>
                      )}
                      {doc.expiry_date && (
                        <span className={new Date(doc.expiry_date) < new Date() ? "text-destructive" : ""}>
                          Expires {format(new Date(doc.expiry_date), "MMM d, yyyy")}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
                <div className="flex items-center gap-1 flex-shrink-0">
                  {isPreviewable(doc.mime_type) && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Preview"
                      onClick={(e) => { e.stopPropagation(); handlePreview(doc); }}
                    >
                      <Eye className="h-4 w-4" />
                    </Button>
                  )}
                  <Button
                    variant="ghost"
                    size="icon"
                    title="Download"
                    onClick={(e) => { e.stopPropagation(); downloadDocument(doc); }}
                  >
                    <Download className="h-4 w-4" />
                  </Button>
                  {canEdit && (
                    <Button
                      variant="ghost"
                      size="icon"
                      title="Delete"
                      onClick={(e) => { e.stopPropagation(); deleteDocument.mutate(doc); }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </CardContent>

      {/* Upload Sheet */}
      <WorkflowSheet
        open={showUpload}
        onOpenChange={setShowUpload}
        size="md"
        title="Upload Document"
        description="Attach a file to this employee's record. PDFs, Office docs and images are supported."
        footer={
          <>
            <Button variant="outline" onClick={() => setShowUpload(false)}>Cancel</Button>
            <Button onClick={handleUpload} disabled={!uploadForm.file || !uploadForm.name || uploadDocument.isPending}>
              {uploadDocument.isPending && <Loader2 className="h-4 w-4 mr-1 animate-spin" />}
              <Upload className="h-4 w-4 mr-1" /> Upload
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Document details" subtitle="Describe what is being uploaded.">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Document Name" required>
              <Input value={uploadForm.name} onChange={(e) => setUploadForm(p => ({ ...p, name: e.target.value }))} placeholder="e.g. Employment Contract" />
            </WorkflowField>
            <WorkflowField label="Document Type">
              <Select value={uploadForm.type} onValueChange={(v) => setUploadForm(p => ({ ...p, type: v }))}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  {DOCUMENT_TYPES.map(t => <SelectItem key={t.value} value={t.value}>{t.label}</SelectItem>)}
                </SelectContent>
              </Select>
            </WorkflowField>
          </div>
          <WorkflowField label="Description">
            <Textarea value={uploadForm.description} onChange={(e) => setUploadForm(p => ({ ...p, description: e.target.value }))} placeholder="Optional description" rows={2} />
          </WorkflowField>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="File" subtitle="PDF, DOC, DOCX, JPG, PNG or WEBP.">
          <WorkflowField label="File" required>
            <Input type="file" onChange={(e) => setUploadForm(p => ({ ...p, file: e.target.files?.[0] || null }))} accept=".pdf,.doc,.docx,.jpg,.jpeg,.png,.webp" />
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>


      {/* Preview Dialog */}
      <Dialog open={!!previewDoc} onOpenChange={(open) => { if (!open) closePreview(); }}>
        <DialogContent className="max-w-4xl w-[90vw] h-[85vh] flex flex-col p-0">
          <DialogHeader className="px-6 pt-6 pb-2 flex flex-row items-center justify-between">
            <div className="min-w-0 pr-4">
              <DialogTitle className="truncate">{previewDoc?.name}</DialogTitle>
              <p className="text-xs text-muted-foreground mt-1">
                {previewDoc?.file_name}
                {previewDoc?.mime_type && ` · ${previewDoc.mime_type}`}
              </p>
            </div>
            <div className="flex items-center gap-2 flex-shrink-0">
              <Button
                variant="outline"
                size="sm"
                onClick={() => { if (previewDoc) downloadDocument(previewDoc); }}
              >
                <Download className="h-4 w-4 mr-1" /> Download
              </Button>
            </div>
          </DialogHeader>

          <div className="flex-1 overflow-hidden px-6 pb-6">
            {previewLoading ? (
              <div className="flex items-center justify-center h-full">
                <Loader2 className="h-8 w-8 animate-spin text-muted-foreground" />
              </div>
            ) : previewUrl ? (
              isImage(previewDoc?.mime_type ?? null) ? (
                <div className="h-full flex items-center justify-center overflow-auto bg-muted/30 rounded-lg">
                  <img
                    src={previewUrl}
                    alt={previewDoc?.name || "Document preview"}
                    className="max-w-full max-h-full object-contain"
                  />
                </div>
              ) : (
                /* ADR-0015 — route the PDF/document preview through the
                   Electron-safe viewer so packaged desktop builds open the
                   file in a dedicated, lifecycle-supervised window instead
                   of a fragile <iframe src={signedUrl}> under file://. */
                <SafePdfViewer
                  pdfUrl={previewUrl}
                  title={previewDoc?.name}
                  filename={previewDoc?.file_name || previewDoc?.name || "document"}
                  className="w-full h-full rounded-lg border bg-background flex flex-col"
                />
              )
            ) : (
              <div className="flex flex-col items-center justify-center h-full text-muted-foreground">
                <FileText className="h-12 w-12 mb-3" />
                <p>Preview not available</p>
                <Button
                  variant="outline"
                  size="sm"
                  className="mt-3"
                  onClick={() => { if (previewDoc) downloadDocument(previewDoc); }}
                >
                  <Download className="h-4 w-4 mr-1" /> Download Instead
                </Button>
              </div>
            )}
          </div>
        </DialogContent>
      </Dialog>
    </Card>
  );
}