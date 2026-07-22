/**
 * LegalOrderDocuments — versioned evidence panel for a legal order.
 *
 * Reads/writes `public.legal_order_documents` and stores blobs in the
 * private `legal-orders` bucket at `{org}/{garnishment}/{version}-{filename}`.
 * The `evidence_requirements` object (from the resolved kind) is used to
 * gate whether the parent form can transition to `active`.
 */
import { useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { supabase } from "@/integrations/supabase/client";
import { useOrganization } from "@/hooks/useOrganization";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { toast } from "sonner";
import { Trash2, UploadCloud, FileText, CheckCircle2, AlertTriangle } from "lucide-react";
import { normalizeError } from "@/services/resilience";

export interface LegalOrderDocumentRow {
  id: string;
  garnishment_id: string;
  organization_id: string;
  version: number;
  document_kind: "order" | "amendment" | "release" | "other";
  storage_bucket: string;
  storage_path: string;
  original_filename: string;
  content_type: string | null;
  byte_size: number | null;
  sha256: string | null;
  uploaded_by: string | null;
  created_at: string;
}

const KINDS: LegalOrderDocumentRow["document_kind"][] = ["order", "amendment", "release", "other"];

async function sha256(file: File): Promise<string> {
  const buf = await file.arrayBuffer();
  const digest = await crypto.subtle.digest("SHA-256", buf);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

interface Props {
  garnishmentId: string | null;                          // null = pre-create; renders a hint
  evidenceRequirements?: Record<string, unknown> | null; // from resolved kind
  canWrite?: boolean;                                    // admin/owner/accountant/super_admin
}

export function LegalOrderDocuments({ garnishmentId, evidenceRequirements, canWrite = true }: Props) {
  const { organization } = useOrganization();
  const qc = useQueryClient();
  const fileRef = useRef<HTMLInputElement>(null);
  const [kind, setKind] = useState<LegalOrderDocumentRow["document_kind"]>("order");

  const { data: docs = [], isLoading } = useQuery<LegalOrderDocumentRow[]>({
    queryKey: ["legal_order_documents", garnishmentId],
    enabled: !!garnishmentId,
    queryFn: async () => {
      const { data, error } = await supabase
        .from("legal_order_documents")
        .select("*")
        .eq("garnishment_id", garnishmentId!)
        .order("created_at", { ascending: false });
      if (error) throw error;
      return (data ?? []) as LegalOrderDocumentRow[];
    },
  });

  const requiredKinds = useMemo<string[]>(() => {
    if (!evidenceRequirements) return [];
    const raw = (evidenceRequirements as any).required_kinds ?? (evidenceRequirements as any).required;
    if (Array.isArray(raw)) return raw.map(String);
    // legacy shape: { order: true, release: true }
    return Object.entries(evidenceRequirements)
      .filter(([, v]) => v === true)
      .map(([k]) => k);
  }, [evidenceRequirements]);

  const providedKinds = useMemo(() => new Set(docs.map((d) => d.document_kind)), [docs]);
  const missing = requiredKinds.filter((k) => !providedKinds.has(k as any));

  const upload = useMutation({
    mutationFn: async (file: File) => {
      if (!organization?.id || !garnishmentId) throw new Error("Save the order first, then attach evidence.");
      const nextVersion = (docs
        .filter((d) => d.document_kind === kind)
        .reduce((max, d) => Math.max(max, d.version), 0)) + 1;
      const safeName = file.name.replace(/[^\w.\-]+/g, "_");
      const path = `${organization.id}/${garnishmentId}/${nextVersion}-${kind}-${safeName}`;
      const hash = await sha256(file);
      const { error: upErr } = await supabase.storage
        .from("legal-orders")
        .upload(path, file, { contentType: file.type || "application/octet-stream", upsert: false });
      if (upErr) throw upErr;
      const { data, error } = await supabase
        .from("legal_order_documents")
        .insert({
          organization_id: organization.id,
          garnishment_id: garnishmentId,
          version: nextVersion,
          document_kind: kind,
          storage_bucket: "legal-orders",
          storage_path: path,
          original_filename: file.name,
          content_type: file.type || null,
          byte_size: file.size,
          sha256: hash,
        })
        .select("*")
        .single();
      if (error) {
        // best-effort cleanup — file is orphaned if row insert fails
        await supabase.storage.from("legal-orders").remove([path]);
        throw error;
      }
      return data as LegalOrderDocumentRow;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["legal_order_documents", garnishmentId] });
      toast.success("Document uploaded");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  const remove = useMutation({
    mutationFn: async (doc: LegalOrderDocumentRow) => {
      await supabase.storage.from(doc.storage_bucket).remove([doc.storage_path]);
      const { error } = await supabase.from("legal_order_documents").delete().eq("id", doc.id);
      if (error) throw error;
    },
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["legal_order_documents", garnishmentId] });
      toast.success("Document removed");
    },
    onError: (e: any) => toast.error(normalizeError(e).message),
  });

  async function openDoc(doc: LegalOrderDocumentRow) {
    const { data, error } = await supabase.storage
      .from(doc.storage_bucket)
      .createSignedUrl(doc.storage_path, 60);
    if (error) return toast.error(error.message);
    window.open(data.signedUrl, "_blank", "noopener,noreferrer");
  }

  return (
    <div className="space-y-3">
      {requiredKinds.length > 0 && (
        <div className={`flex items-start gap-2 rounded-md border px-3 py-2 text-xs ${missing.length === 0 ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-amber-200 bg-amber-50 text-amber-900"}`}>
          {missing.length === 0 ? (
            <CheckCircle2 className="h-4 w-4 mt-[1px]" />
          ) : (
            <AlertTriangle className="h-4 w-4 mt-[1px]" />
          )}
          <div>
            <div className="font-medium">
              {missing.length === 0 ? "Evidence complete" : `Missing required evidence: ${missing.join(", ")}`}
            </div>
            <div className="opacity-80">
              Required by the resolved order kind: {requiredKinds.join(", ")}.
            </div>
          </div>
        </div>
      )}

      {!garnishmentId ? (
        <p className="text-xs text-muted-foreground">
          Save the order first, then upload the court order, amendments and any release notice here.
        </p>
      ) : (
        <>
          {canWrite && (
            <div className="flex items-center gap-2">
              <Select value={kind} onValueChange={(v) => setKind(v as any)}>
                <SelectTrigger className="w-40">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {KINDS.map((k) => (
                    <SelectItem key={k} value={k}>{k}</SelectItem>
                  ))}
                </SelectContent>
              </Select>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) upload.mutate(f);
                  if (fileRef.current) fileRef.current.value = "";
                }}
              />
              <Button type="button" size="sm" variant="outline" onClick={() => fileRef.current?.click()} disabled={upload.isPending}>
                <UploadCloud className="h-4 w-4 mr-1" />
                {upload.isPending ? "Uploading…" : "Upload evidence"}
              </Button>
            </div>
          )}
          {isLoading ? (
            <p className="text-xs text-muted-foreground">Loading documents…</p>
          ) : docs.length === 0 ? (
            <p className="text-xs text-muted-foreground">No documents attached yet.</p>
          ) : (
            <ul className="divide-y rounded-md border">
              {docs.map((d) => (
                <li key={d.id} className="flex items-center gap-3 px-3 py-2 text-xs">
                  <FileText className="h-4 w-4 text-muted-foreground" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2">
                      <span className="truncate font-medium">{d.original_filename}</span>
                      <Badge variant="outline" className="text-[10px]">{d.document_kind} · v{d.version}</Badge>
                    </div>
                    <div className="text-muted-foreground">
                      {new Date(d.created_at).toLocaleString()}
                      {d.byte_size ? ` · ${(d.byte_size / 1024).toFixed(1)} KB` : ""}
                      {d.sha256 ? ` · sha256:${d.sha256.slice(0, 10)}…` : ""}
                    </div>
                  </div>
                  <Button type="button" size="sm" variant="ghost" onClick={() => openDoc(d)}>Open</Button>
                  {canWrite && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        if (confirm(`Remove "${d.original_filename}"? This deletes the file and audit row.`)) {
                          remove.mutate(d);
                        }
                      }}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </div>
  );
}
