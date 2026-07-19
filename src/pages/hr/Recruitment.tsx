/**
 * Recruitment (Turn H) — single workspace page covering requisitions and
 * application pipeline. Lives at /hr/recruitment.
 */
import { useMemo, useState } from "react";
import {
  useRequisitions, useCandidates, useApplications, useOffers, useInterviewFeedback,
  type JobRequisition, type Candidate, type CandidateApplication,
  type ApplicationStage, type RequisitionStatus, type OfferLetter,
} from "@/hooks/useRecruitment";
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import { Select, SelectTrigger, SelectValue, SelectContent, SelectItem } from "@/components/ui/select";
import { WorkflowSheet, WorkflowSheetSection, WorkflowSheetGrid, WorkflowField } from "@/components/workflow/WorkflowSheet";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Briefcase, Plus, UserPlus, ArrowRight, Star, Printer, FileText } from "lucide-react";
import { usePrintOrPreview } from "@/hooks/usePrintOrPreview";
import { PrintPreviewDialog } from "@/components/common/PrintPreviewDialog";
import { DocumentHistorySheet } from "@/components/documents/DocumentHistorySheet";

const STAGES: ApplicationStage[] = ["applied", "screen", "interview", "assessment", "offer", "hired", "rejected", "withdrawn"];
const REQ_STATUS: RequisitionStatus[] = ["draft", "open", "on_hold", "filled", "closed", "cancelled"];

export default function RecruitmentPage() {
  const [tab, setTab] = useState("requisitions");
  return (
    <div className="space-y-4">
      <Tabs value={tab} onValueChange={setTab}>
        <TabsList>
          <TabsTrigger value="requisitions">Requisitions</TabsTrigger>
          <TabsTrigger value="pipeline">Pipeline</TabsTrigger>
          <TabsTrigger value="candidates">Candidates</TabsTrigger>
        </TabsList>
        <TabsContent value="requisitions"><RequisitionsTab /></TabsContent>
        <TabsContent value="pipeline"><PipelineTab /></TabsContent>
        <TabsContent value="candidates"><CandidatesTab /></TabsContent>
      </Tabs>
    </div>
  );
}

function RequisitionsTab() {
  const { requisitions, isLoading, createRequisition, updateRequisition } = useRequisitions();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ title: "", headcount: 1, employment_type: "full_time", description: "" });

  async function submit() {
    await createRequisition.mutateAsync({ ...form, status: "open", opened_at: new Date().toISOString() });
    setOpen(false);
    setForm({ title: "", headcount: 1, employment_type: "full_time", description: "" });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div>
          <CardTitle className="flex items-center gap-2"><Briefcase className="h-5 w-5" /> Job Requisitions</CardTitle>
          <CardDescription>Open headcount tracked by hiring manager and department.</CardDescription>
        </div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> New Requisition</Button>
      </CardHeader>
      <CardContent>
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
         : requisitions.length === 0 ? <p className="text-sm text-muted-foreground">No requisitions yet.</p>
         : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Title</TableHead><TableHead>Headcount</TableHead>
              <TableHead>Type</TableHead><TableHead>Status</TableHead>
              <TableHead>Opened</TableHead><TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {requisitions.map((r) => (
                <TableRow key={r.id}>
                  <TableCell className="font-medium">{r.title}</TableCell>
                  <TableCell>{r.headcount}</TableCell>
                  <TableCell className="text-xs">{r.employment_type ?? "—"}</TableCell>
                  <TableCell>
                    <Select value={r.status} onValueChange={(v) => updateRequisition.mutate({ id: r.id, patch: { status: v as RequisitionStatus, opened_at: v === "open" && !r.opened_at ? new Date().toISOString() : r.opened_at } })}>
                      <SelectTrigger className="h-7 w-32 text-xs"><SelectValue /></SelectTrigger>
                      <SelectContent>{REQ_STATUS.map((s) => <SelectItem key={s} value={s}>{s.replace("_", " ")}</SelectItem>)}</SelectContent>
                    </Select>
                  </TableCell>
                  <TableCell className="text-xs">{r.opened_at ? new Date(r.opened_at).toLocaleDateString() : "—"}</TableCell>
                  <TableCell />
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <WorkflowSheet
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title="New Requisition"
        description="Open a hiring slot. Candidates can be linked once the requisition is active."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!form.title}>Create</Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Role" subtitle="What the requisition is for.">
          <WorkflowField label="Title" required>
            <Input value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Senior Backend Engineer" />
          </WorkflowField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Headcount">
              <Input type="number" min={1} value={form.headcount} onChange={(e) => setForm({ ...form, headcount: Number(e.target.value) })} />
            </WorkflowField>
            <WorkflowField label="Employment Type">
              <Select value={form.employment_type} onValueChange={(v) => setForm({ ...form, employment_type: v })}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>{["full_time","part_time","contract","intern","temporary"].map((t) => <SelectItem key={t} value={t}>{t.replace("_"," ")}</SelectItem>)}</SelectContent>
              </Select>
            </WorkflowField>
          </div>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Description" subtitle="Scope, responsibilities and qualifications.">
          <Textarea rows={6} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} />
        </WorkflowSheetSection>
      </WorkflowSheet>

    </Card>
  );
}

function PipelineTab() {
  const { requisitions } = useRequisitions();
  const [reqId, setReqId] = useState<string>("");
  const openReqs = useMemo(() => requisitions.filter((r) => r.status === "open" || r.status === "draft"), [requisitions]);
  const activeReq = requisitions.find((r) => r.id === reqId) ?? openReqs[0];

  return (
    <div className="space-y-4">
      <div className="flex gap-3 items-end max-w-md">
        <div className="flex-1">
          <Label>Requisition</Label>
          <Select value={activeReq?.id ?? ""} onValueChange={setReqId}>
            <SelectTrigger><SelectValue placeholder="Select requisition" /></SelectTrigger>
            <SelectContent>
              {requisitions.map((r) => (
                <SelectItem key={r.id} value={r.id}>{r.title} · {r.status}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {activeReq && <RequisitionPipeline requisition={activeReq} />}
    </div>
  );
}

function RequisitionPipeline({ requisition }: { requisition: JobRequisition }) {
  const { applications, updateStage, convertToEmployee } = useApplications(requisition.id);
  const { candidates } = useCandidates();
  const candById = useMemo(() => {
    const m = new Map<string, Candidate>(); for (const c of candidates) m.set(c.id, c); return m;
  }, [candidates]);

  const byStage = useMemo(() => {
    const m = new Map<ApplicationStage, CandidateApplication[]>();
    for (const s of STAGES) m.set(s, []);
    for (const a of applications) m.get(a.stage)?.push(a);
    return m;
  }, [applications]);

  const [hireOpen, setHireOpen] = useState<CandidateApplication | null>(null);
  const [hireForm, setHireForm] = useState({ hire_date: new Date().toISOString().slice(0, 10), basic_salary: "" });

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-3">
      {STAGES.map((stage) => (
        <Card key={stage}>
          <CardHeader className="pb-2">
            <CardTitle className="text-sm uppercase tracking-wide">{stage.replace("_", " ")}</CardTitle>
            <CardDescription>{byStage.get(stage)?.length ?? 0} candidate(s)</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            {(byStage.get(stage) ?? []).map((a) => {
              const c = candById.get(a.candidate_id);
              return (
                <div key={a.id} className="border rounded-md p-2 space-y-1">
                  <div className="text-sm font-medium">{c?.full_name ?? "Unknown"}</div>
                  <div className="text-xs text-muted-foreground">{c?.current_title ?? ""}</div>
                  <div className="flex gap-1 flex-wrap pt-1">
                    {stage !== "hired" && stage !== "rejected" && stage !== "withdrawn" && (
                      <>
                        <Select value="" onValueChange={(v) => updateStage.mutate({ id: a.id, stage: v as ApplicationStage })}>
                          <SelectTrigger className="h-7 w-full text-xs"><SelectValue placeholder="Move →" /></SelectTrigger>
                          <SelectContent>
                            {STAGES.filter((s) => s !== stage).map((s) => <SelectItem key={s} value={s}>{s.replace("_"," ")}</SelectItem>)}
                          </SelectContent>
                        </Select>
                        {stage === "offer" && (
                          <Button size="sm" className="w-full h-7 text-xs" onClick={() => setHireOpen(a)}>
                            <UserPlus className="h-3 w-3 mr-1" /> Hire
                          </Button>
                        )}
                      </>
                    )}
                    {stage === "offer" && (
                      <OfferActions application={a} candidateName={c?.full_name ?? "Candidate"} />
                    )}
                    {stage === "hired" && a.converted_employee_id && (
                      <Badge variant="secondary" className="text-xs">Employee created</Badge>
                    )}
                  </div>
                </div>
              );
            })}
          </CardContent>
        </Card>
      ))}

      


      <WorkflowSheet
        open={!!hireOpen}
        onOpenChange={(o) => !o && setHireOpen(null)}
        size="md"
        title="Convert candidate to employee"
        description="Creates an active employee record, marks the application as hired, and closes the requisition once headcount is filled."
        footer={
          <>
            <Button variant="outline" onClick={() => setHireOpen(null)}>Cancel</Button>
            <Button
              onClick={async () => {
                if (!hireOpen) return;
                await convertToEmployee.mutateAsync({
                  application_id: hireOpen.id,
                  payload: {
                    hire_date: hireForm.hire_date,
                    basic_salary: hireForm.basic_salary ? Number(hireForm.basic_salary) : 0,
                  },
                });
                setHireOpen(null);
              }}
            >
              <ArrowRight className="h-4 w-4 mr-1" /> Convert
            </Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Hire details">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Hire date" required>
              <Input type="date" value={hireForm.hire_date} onChange={(e) => setHireForm({ ...hireForm, hire_date: e.target.value })} />
            </WorkflowField>
            <WorkflowField label="Basic salary">
              <Input type="number" step="0.01" value={hireForm.basic_salary} onChange={(e) => setHireForm({ ...hireForm, basic_salary: e.target.value })} />
            </WorkflowField>
          </div>
        </WorkflowSheetSection>
      </WorkflowSheet>

    </div>
  );
}

function CandidatesTab() {
  const { candidates, isLoading, createCandidate } = useCandidates();
  const { requisitions } = useRequisitions();
  const { createApplication } = useApplications();
  const [open, setOpen] = useState(false);
  const [form, setForm] = useState({ full_name: "", email: "", phone: "", source: "", current_title: "", current_company: "", linkedin_url: "" });
  const [linkOpen, setLinkOpen] = useState<Candidate | null>(null);
  const [linkReq, setLinkReq] = useState<string>("");

  async function submit() {
    await createCandidate.mutateAsync(form);
    setOpen(false);
    setForm({ full_name: "", email: "", phone: "", source: "", current_title: "", current_company: "", linkedin_url: "" });
  }

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between">
        <div><CardTitle>Talent Pool</CardTitle><CardDescription>Candidates across all requisitions.</CardDescription></div>
        <Button onClick={() => setOpen(true)}><Plus className="h-4 w-4 mr-1" /> Add Candidate</Button>
      </CardHeader>
      <CardContent>
        {isLoading ? <p className="text-sm text-muted-foreground">Loading…</p>
         : candidates.length === 0 ? <p className="text-sm text-muted-foreground">No candidates yet.</p>
         : (
          <Table>
            <TableHeader><TableRow>
              <TableHead>Name</TableHead><TableHead>Email</TableHead><TableHead>Title</TableHead>
              <TableHead>Source</TableHead><TableHead>Added</TableHead><TableHead></TableHead>
            </TableRow></TableHeader>
            <TableBody>
              {candidates.map((c) => (
                <TableRow key={c.id}>
                  <TableCell className="font-medium">{c.full_name}</TableCell>
                  <TableCell className="text-xs">{c.email ?? "—"}</TableCell>
                  <TableCell className="text-xs">{c.current_title ?? "—"} {c.current_company ? `@ ${c.current_company}` : ""}</TableCell>
                  <TableCell><Badge variant="outline">{c.source ?? "direct"}</Badge></TableCell>
                  <TableCell className="text-xs">{new Date(c.created_at).toLocaleDateString()}</TableCell>
                  <TableCell><Button size="sm" variant="ghost" onClick={() => { setLinkOpen(c); setLinkReq(""); }}>Link to req</Button></TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        )}
      </CardContent>

      <WorkflowSheet
        open={open}
        onOpenChange={setOpen}
        size="lg"
        title="Add Candidate"
        description="Capture a candidate's contact and background details."
        footer={
          <>
            <Button variant="outline" onClick={() => setOpen(false)}>Cancel</Button>
            <Button onClick={submit} disabled={!form.full_name}>Add</Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Identity">
          <WorkflowField label="Full name" required>
            <Input value={form.full_name} onChange={(e) => setForm({ ...form, full_name: e.target.value })} />
          </WorkflowField>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Email"><Input type="email" value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></WorkflowField>
            <WorkflowField label="Phone"><Input value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} /></WorkflowField>
          </div>
        </WorkflowSheetSection>
        <WorkflowSheetSection number={2} title="Background">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <WorkflowField label="Current title"><Input value={form.current_title} onChange={(e) => setForm({ ...form, current_title: e.target.value })} /></WorkflowField>
            <WorkflowField label="Current company"><Input value={form.current_company} onChange={(e) => setForm({ ...form, current_company: e.target.value })} /></WorkflowField>
          </div>
          <WorkflowField label="LinkedIn URL"><Input value={form.linkedin_url} onChange={(e) => setForm({ ...form, linkedin_url: e.target.value })} /></WorkflowField>
          <WorkflowField label="Source"><Input value={form.source} onChange={(e) => setForm({ ...form, source: e.target.value })} placeholder="referral, linkedin, careers page…" /></WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>

      <WorkflowSheet
        open={!!linkOpen}
        onOpenChange={(o) => !o && setLinkOpen(null)}
        size="md"
        title={`Link ${linkOpen?.full_name ?? "candidate"} to requisition`}
        description="Creates an application on the selected open requisition."
        footer={
          <>
            <Button variant="outline" onClick={() => setLinkOpen(null)}>Cancel</Button>
            <Button
              disabled={!linkReq || !linkOpen}
              onClick={async () => {
                if (!linkOpen || !linkReq) return;
                await createApplication.mutateAsync({ candidate_id: linkOpen.id, requisition_id: linkReq });
                setLinkOpen(null);
              }}
            >Apply</Button>
          </>
        }
      >
        <WorkflowSheetSection number={1} title="Requisition">
          <WorkflowField label="Open requisition" required>
            <Select value={linkReq} onValueChange={setLinkReq}>
              <SelectTrigger><SelectValue placeholder="Select requisition" /></SelectTrigger>
              <SelectContent>
                {requisitions.filter((r) => r.status === "open" || r.status === "draft").map((r) => (
                  <SelectItem key={r.id} value={r.id}>{r.title}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>
      </WorkflowSheet>

    </Card>
  );
}
