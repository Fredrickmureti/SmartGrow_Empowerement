/**
 * MyOneOnOneDetail — shared agenda, talking points, private notes, action
 * items, and completion for a single 1:1. Private-note column for the
 * "other side" is masked at the view level (see one_on_ones_visible).
 */
import { useEffect, useState } from "react";
import { Link, useParams } from "react-router-dom";
import { useOneOnOne, useOneOnOnes } from "@/hooks/useContinuousPerformance";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import { Checkbox } from "@/components/ui/checkbox";
import { ArrowLeft, CheckCircle2, Plus, Trash2 } from "lucide-react";

export default function MyOneOnOneDetail() {
  const { id } = useParams();
  const { currentEmployee } = useCurrentEmployee();
  const { meeting, talkingPoints, addTalkingPoint, toggleAddressed, removeTalkingPoint, saveNotes, saveActionItems } = useOneOnOne(id);
  const { complete } = useOneOnOnes();

  const isManager = !!meeting && currentEmployee?.id === meeting.manager_id;
  const isEmployee = !!meeting && currentEmployee?.id === meeting.employee_id;
  const role: "manager" | "employee" = isManager ? "manager" : "employee";

  const [tp, setTp] = useState("");
  const [summary, setSummary] = useState("");
  const [privateNotes, setPrivateNotes] = useState("");
  useEffect(() => {
    if (!meeting) return;
    setSummary(meeting.shared_summary ?? "");
    setPrivateNotes((isManager ? meeting.private_notes_manager : meeting.private_notes_employee) ?? "");
  }, [meeting, isManager]);

  if (!meeting) {
    return (
      <div className="space-y-3">
        <Button asChild variant="ghost" size="sm"><Link to="/me/one-on-ones"><ArrowLeft className="h-4 w-4 mr-1" /> Back</Link></Button>
        <Card><CardContent className="py-8 text-sm text-muted-foreground">Loading…</CardContent></Card>
      </div>
    );
  }

  const items = meeting.action_items ?? [];

  return (
    <div className="space-y-4">
      <Button asChild variant="ghost" size="sm"><Link to="/me/one-on-ones"><ArrowLeft className="h-4 w-4 mr-1" /> Back to 1:1s</Link></Button>

      <div className="flex items-center justify-between flex-wrap gap-2">
        <div>
          <h1 className="text-xl font-semibold">1:1 — {new Date(meeting.scheduled_at).toLocaleString()}</h1>
          <p className="text-sm text-muted-foreground">{meeting.duration_minutes} min · {meeting.recurrence ?? "none"}</p>
        </div>
        <div className="flex items-center gap-2">
          <Badge>{meeting.status}</Badge>
          {meeting.status === "scheduled" ? (
            <Button size="sm" onClick={() => complete.mutate({ id: meeting.id, summary })}>
              <CheckCircle2 className="h-4 w-4 mr-1" /> Mark complete
            </Button>
          ) : null}
        </div>
      </div>

      <Card>
        <CardHeader><CardTitle className="text-base">Shared agenda</CardTitle><CardDescription>Both sides can add and address points.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          <div className="flex gap-2">
            <Input value={tp} onChange={(e) => setTp(e.target.value)} placeholder="Add a talking point…" />
            <Button onClick={async () => { if (tp.trim()) { await addTalkingPoint.mutateAsync({ body: tp, author_role: role }); setTp(""); } }}>
              <Plus className="h-4 w-4" />
            </Button>
          </div>
          {talkingPoints.length === 0 ? <p className="text-sm text-muted-foreground">No talking points yet.</p> :
            talkingPoints.map((p) => (
              <div key={p.id} className="flex items-start gap-2 rounded-md border px-3 py-2">
                <Checkbox checked={p.is_addressed} onCheckedChange={(v) => toggleAddressed.mutate({ tpId: p.id, addressed: !!v })} />
                <div className="flex-1 min-w-0">
                  <p className={"text-sm " + (p.is_addressed ? "line-through text-muted-foreground" : "")}>{p.body}</p>
                  <p className="text-[10px] text-muted-foreground">Added by {p.author_role}</p>
                </div>
                <Button size="icon" variant="ghost" onClick={() => removeTalkingPoint.mutate(p.id)}><Trash2 className="h-4 w-4" /></Button>
              </div>
            ))}
        </CardContent>
      </Card>

      <Card>
        <CardHeader><CardTitle className="text-base">Shared summary</CardTitle><CardDescription>Visible to both sides.</CardDescription></CardHeader>
        <CardContent className="space-y-2">
          <Textarea rows={4} value={summary} onChange={(e) => setSummary(e.target.value)} />
          <div className="flex justify-end">
            <Button size="sm" variant="outline" onClick={() => saveNotes.mutate({ field: "shared_summary", value: summary })}>Save summary</Button>
          </div>
        </CardContent>
      </Card>

      {(isManager || isEmployee) ? (
        <Card>
          <CardHeader>
            <CardTitle className="text-base">My private notes</CardTitle>
            <CardDescription>Only you can see this. The other side has their own private notes.</CardDescription>
          </CardHeader>
          <CardContent className="space-y-2">
            <Textarea rows={4} value={privateNotes} onChange={(e) => setPrivateNotes(e.target.value)} />
            <div className="flex justify-end">
              <Button size="sm" variant="outline" onClick={() => saveNotes.mutate({ field: isManager ? "private_notes_manager" : "private_notes_employee", value: privateNotes })}>
                Save private notes
              </Button>
            </div>
          </CardContent>
        </Card>
      ) : null}

      <Card>
        <CardHeader><CardTitle className="text-base">Action items</CardTitle></CardHeader>
        <CardContent className="space-y-2">
          {items.map((it: any, idx: number) => (
            <div key={it.id ?? idx} className="flex items-center gap-2 rounded-md border px-3 py-2">
              <Checkbox checked={!!it.done} onCheckedChange={(v) => {
                const next = items.map((x: any, i: number) => i === idx ? { ...x, done: !!v } : x);
                saveActionItems.mutate(next);
              }} />
              <span className={"flex-1 text-sm " + (it.done ? "line-through text-muted-foreground" : "")}>{it.text}</span>
              <Badge variant="outline" className="text-[10px]">{it.owner}</Badge>
              <Button size="icon" variant="ghost" onClick={() => saveActionItems.mutate(items.filter((_: any, i: number) => i !== idx))}><Trash2 className="h-4 w-4" /></Button>
            </div>
          ))}
          <AddActionItem onAdd={(text, owner) => saveActionItems.mutate([...items, { id: crypto.randomUUID(), text, owner, done: false }])} />
        </CardContent>
      </Card>
    </div>
  );
}

function AddActionItem({ onAdd }: { onAdd: (text: string, owner: "manager" | "employee") => void }) {
  const [text, setText] = useState("");
  const [owner, setOwner] = useState<"manager" | "employee">("manager");
  return (
    <div className="flex gap-2 items-center pt-2 border-t">
      <Input value={text} onChange={(e) => setText(e.target.value)} placeholder="New action item…" />
      <select className="text-xs border rounded-md px-2 py-2 bg-background" value={owner} onChange={(e) => setOwner(e.target.value as any)}>
        <option value="manager">Manager</option>
        <option value="employee">Employee</option>
      </select>
      <Button onClick={() => { if (text.trim()) { onAdd(text.trim(), owner); setText(""); } }}><Plus className="h-4 w-4" /></Button>
    </div>
  );
}