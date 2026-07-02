/**
 * CourseMaterialsManager — list + add/remove materials (files, links, text)
 * for a training course. Used inside the Course editor dialog.
 */
import { useRef, useState } from "react";
import { useCourseMaterials, type CourseMaterial } from "@/hooks/useCourseMaterials";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Paperclip, Link2, FileText, Trash2, Download, ExternalLink, Upload, ArrowUp, ArrowDown } from "lucide-react";
import { supabase } from "@/integrations/supabase/client";
import { toast } from "sonner";

function isSafeUrl(u: string): boolean {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:";
  } catch { return false; }
}

function formatBytes(n: number | null) {
  if (!n && n !== 0) return "";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function CourseMaterialsManager({ courseId }: { courseId: string }) {
  const { materials, isLoading, addFile, addLink, addText, remove, reorder } = useCourseMaterials(courseId);
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [linkForm, setLinkForm] = useState({ title: "", external_url: "", description: "" });
  const [textForm, setTextForm] = useState({ title: "", content_text: "" });
  const [fileTitle, setFileTitle] = useState("");

  function move(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= materials.length) return;
    const ids = materials.map((m) => m.id);
    [ids[idx], ids[target]] = [ids[target], ids[idx]];
    reorder.mutate(ids);
  }

  async function downloadMaterial(m: CourseMaterial) {
    if (!m.file_path) return;
    const { data } = await supabase.storage.from("documents").createSignedUrl(m.file_path, 60 * 60);
    if (data?.signedUrl) window.open(data.signedUrl, "_blank");
  }

  return (
    <div className="space-y-4">
      <div>
        <Label className="text-xs uppercase tracking-wide text-muted-foreground">Materials</Label>
        {isLoading ? (
          <p className="text-sm text-muted-foreground mt-2">Loading…</p>
        ) : materials.length === 0 ? (
          <p className="text-sm text-muted-foreground mt-2">No materials yet. Add a file, link, or text lesson below.</p>
        ) : (
          <ul className="mt-2 space-y-2">
            {materials.map((m, idx) => (
              <li key={m.id} className="flex items-center justify-between gap-2 rounded-md border p-2">
                <div className="flex items-center gap-2 min-w-0">
                  {m.kind === "file" && <Paperclip className="h-4 w-4 text-muted-foreground shrink-0" />}
                  {m.kind === "link" && <Link2 className="h-4 w-4 text-muted-foreground shrink-0" />}
                  {m.kind === "text" && <FileText className="h-4 w-4 text-muted-foreground shrink-0" />}
                  <div className="min-w-0">
                    <p className="text-sm font-medium truncate">{m.title}</p>
                    <p className="text-xs text-muted-foreground truncate">
                      {m.kind === "file" && <>{m.file_name} · {formatBytes(m.file_size)}</>}
                      {m.kind === "link" && m.external_url}
                      {m.kind === "text" && (m.content_text?.slice(0, 80) ?? "")}
                    </p>
                  </div>
                  <Badge variant="outline" className="text-[10px] uppercase">{m.kind}</Badge>
                </div>
                <div className="flex items-center gap-1 shrink-0">
                  <Button size="icon" variant="ghost" disabled={idx === 0 || reorder.isPending} onClick={() => move(idx, -1)} title="Move up"><ArrowUp className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" disabled={idx === materials.length - 1 || reorder.isPending} onClick={() => move(idx, 1)} title="Move down"><ArrowDown className="h-4 w-4" /></Button>
                  {m.kind === "file" && (
                    <Button size="icon" variant="ghost" onClick={() => downloadMaterial(m)} title="Download">
                      <Download className="h-4 w-4" />
                    </Button>
                  )}
                  {m.kind === "link" && m.external_url && isSafeUrl(m.external_url) && (
                    <Button size="icon" variant="ghost" asChild title="Open">
                      <a href={m.external_url} target="_blank" rel="noreferrer noopener"><ExternalLink className="h-4 w-4" /></a>
                    </Button>
                  )}
                  <Button size="icon" variant="ghost" onClick={() => {
                    if (confirm(`Remove "${m.title}"?`)) remove.mutate(m);
                  }} title="Remove">
                    <Trash2 className="h-4 w-4 text-destructive" />
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </div>

      <Card>
        <CardContent className="pt-4">
          <Tabs defaultValue="file">
            <TabsList>
              <TabsTrigger value="file"><Paperclip className="h-3.5 w-3.5 mr-1" /> File</TabsTrigger>
              <TabsTrigger value="link"><Link2 className="h-3.5 w-3.5 mr-1" /> Link</TabsTrigger>
              <TabsTrigger value="text"><FileText className="h-3.5 w-3.5 mr-1" /> Text</TabsTrigger>
            </TabsList>
            <TabsContent value="file" className="space-y-3 pt-3">
              <div>
                <Label>Title (optional)</Label>
                <Input value={fileTitle} onChange={(e) => setFileTitle(e.target.value)} placeholder="Defaults to file name" />
              </div>
              <input
                ref={fileRef}
                type="file"
                className="hidden"
                onChange={async (e) => {
                  const f = e.target.files?.[0];
                  if (!f) return;
                  await addFile.mutateAsync({ title: fileTitle, file: f });
                  setFileTitle("");
                  if (fileRef.current) fileRef.current.value = "";
                }}
              />
              <Button onClick={() => fileRef.current?.click()} disabled={addFile.isPending}>
                <Upload className="h-4 w-4 mr-1" /> {addFile.isPending ? "Uploading…" : "Choose file (max 50 MB)"}
              </Button>
              <p className="text-xs text-muted-foreground">PDF, slides, video, etc.</p>
            </TabsContent>
            <TabsContent value="link" className="space-y-3 pt-3">
              <div><Label>Title</Label><Input value={linkForm.title} onChange={(e) => setLinkForm({ ...linkForm, title: e.target.value })} /></div>
              <div><Label>URL</Label><Input value={linkForm.external_url} onChange={(e) => setLinkForm({ ...linkForm, external_url: e.target.value })} placeholder="https://…" /></div>
              <div><Label>Notes (optional)</Label><Input value={linkForm.description} onChange={(e) => setLinkForm({ ...linkForm, description: e.target.value })} /></div>
              <Button onClick={async () => {
                  if (!isSafeUrl(linkForm.external_url)) { toast.error("URL must start with http:// or https://"); return; }
                  await addLink.mutateAsync(linkForm); setLinkForm({ title: "", external_url: "", description: "" });
                }}
                disabled={!linkForm.title || !linkForm.external_url || addLink.isPending}>
                Add link
              </Button>
            </TabsContent>
            <TabsContent value="text" className="space-y-3 pt-3">
              <div><Label>Title</Label><Input value={textForm.title} onChange={(e) => setTextForm({ ...textForm, title: e.target.value })} /></div>
              <div><Label>Content</Label><Textarea value={textForm.content_text} onChange={(e) => setTextForm({ ...textForm, content_text: e.target.value })} rows={6} /></div>
              <Button onClick={async () => { await addText.mutateAsync(textForm); setTextForm({ title: "", content_text: "" }); }}
                disabled={!textForm.title || !textForm.content_text || addText.isPending}>
                Add lesson
              </Button>
            </TabsContent>
          </Tabs>
        </CardContent>
      </Card>
    </div>
  );
}
