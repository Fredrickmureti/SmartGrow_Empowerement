/**
 * Public Careers page (Turn H) — anonymous viewers see open requisitions for
 * the org passed via ?org=<uuid> and can submit themselves into `candidates`.
 *
 * The page is intentionally read-restricted: it only renders if an org id is
 * provided in the URL; without it we render an instructions banner. Anon users
 * cannot read the requisitions table by default — to keep this card simple we
 * rely on the public-but-scoped GET via the same RLS that exposes requisitions
 * to org members (so the careers page is best used while signed in or as part
 * of an embedded iframe with an authenticated session).
 *
 * Anonymous candidate insert is allowed via the `cand insert anon careers`
 * policy.
 */
import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { supabase } from "@/integrations/supabase/client";
import { useQuery } from "@tanstack/react-query";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { toast } from "sonner";
import { Briefcase, Send, CheckCircle2 } from "lucide-react";

export default function CareersPage() {
  const [params] = useSearchParams();
  const orgId = params.get("org") ?? "";

  const { data: requisitions = [], isLoading } = useQuery({
    queryKey: ["public-requisitions", orgId],
    queryFn: async () => {
      if (!orgId) return [];
      const { data, error } = await supabase
        .from("job_requisitions")
        .select("id,title,description,employment_type,department_id,headcount,opened_at")
        .eq("organization_id", orgId)
        .eq("status", "open");
      if (error) throw error;
      return data ?? [];
    },
    enabled: !!orgId,
  });

  const [form, setForm] = useState({ full_name: "", email: "", phone: "", linkedin_url: "", notes: "" });
  const [sent, setSent] = useState(false);

  async function submit() {
    if (!orgId) return;
    const { error } = await supabase.from("candidates").insert({
      organization_id: orgId,
      full_name: form.full_name,
      email: form.email || null,
      phone: form.phone || null,
      linkedin_url: form.linkedin_url || null,
      notes: form.notes || null,
      source: "careers_page",
      tags: [],
    });
    if (error) {
      toast.error(error.message);
      return;
    }
    setSent(true);
    toast.success("Application received");
  }

  return (
    <div className="container max-w-4xl mx-auto py-12 space-y-8">
      <header className="space-y-2">
        <h1 className="text-3xl font-semibold flex items-center gap-2"><Briefcase className="h-6 w-6" /> Careers</h1>
        <p className="text-muted-foreground">Join our team. Open roles and a quick application form below.</p>
      </header>

      {!orgId && (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Add <code className="px-1 bg-muted rounded">?org=&lt;organization-id&gt;</code> to the URL to view that workspace's open roles.
          </CardContent>
        </Card>
      )}

      {orgId && (
        <Card>
          <CardHeader>
            <CardTitle>Open Positions</CardTitle>
            <CardDescription>{requisitions.length} role(s) currently open.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-3">
            {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
             : requisitions.length === 0 ? <p className="text-sm text-muted-foreground">No open roles right now — check back soon.</p>
             : requisitions.map((r: any) => (
              <div key={r.id} className="border rounded-md p-4 space-y-1">
                <div className="flex justify-between items-start">
                  <h3 className="font-medium">{r.title}</h3>
                  <Badge variant="outline">{r.employment_type ?? "full_time"}</Badge>
                </div>
                {r.description && <p className="text-sm text-muted-foreground whitespace-pre-wrap">{r.description}</p>}
                <p className="text-xs text-muted-foreground">{r.headcount} opening(s) · posted {r.opened_at ? new Date(r.opened_at).toLocaleDateString() : ""}</p>
              </div>
            ))}
          </CardContent>
        </Card>
      )}

      {orgId && (
        <Card>
          <CardHeader>
            <CardTitle>Apply</CardTitle>
            <CardDescription>Submit your details — we'll be in touch.</CardDescription>
          </CardHeader>
          <CardContent>
            {sent ? (
              <div className="flex items-center gap-2 text-sm text-foreground">
                <CheckCircle2 className="h-5 w-5 text-green-600" /> Thanks! Your application has been received.
              </div>
            ) : (
              <div className="grid grid-cols-2 gap-3">
                <div className="col-span-2"><Label>Full name</Label><Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} /></div>
                <div><Label>Email</Label><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></div>
                <div><Label>Phone</Label><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></div>
                <div className="col-span-2"><Label>LinkedIn URL</Label><Input value={form.linkedin_url} onChange={(e) => setForm({ ...form, linkedin_url: e.target.value })} /></div>
                <div className="col-span-2"><Label>Cover note</Label><Textarea rows={4} value={form.notes} onChange={(e) => setForm({ ...form, notes: e.target.value })} placeholder="Which role interests you? Tell us about yourself." /></div>
                <div className="col-span-2 flex justify-end">
                  <Button onClick={submit} disabled={!form.full_name}><Send className="h-4 w-4 mr-1" /> Submit</Button>
                </div>
              </div>
            )}
          </CardContent>
        </Card>
      )}
    </div>
  );
}
