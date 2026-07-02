/**
 * FeedbackComposer — TalentFormShell-based composer for sending praise /
 * constructive / request feedback, plus a sibling KudosComposer that posts
 * public recognition. Both share the same enterprise sheet pattern so they
 * feel consistent with the rest of the Talent app.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useEmployees } from "@/hooks/useEmployees";
import { useContinuousFeedback, useKudos, FeedbackType, FeedbackVisibility } from "@/hooks/useContinuousPerformance";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { MessageSquarePlus } from "lucide-react";
import { TalentFormShell } from "@/components/talent/_shared/TalentFormShell";
import {
  WorkflowSheetGrid,
  WorkflowSheetSection,
  WorkflowField,
} from "@/components/workflow/WorkflowSheet";

export function FeedbackComposer({ trigger, defaultTo }: { trigger?: React.ReactNode; defaultTo?: string }) {
  const [open, setOpen] = useState(false);
  const { employees } = useEmployees();
  const { currentEmployee } = useCurrentEmployee();
  const { send } = useContinuousFeedback();
  const [to, setTo] = useState(defaultTo ?? "");
  const [type, setType] = useState<FeedbackType>("praise");
  const [visibility, setVisibility] = useState<FeedbackVisibility>("private");
  const [body, setBody] = useState("");

  const others = employees.filter((e: any) => e.id !== currentEmployee?.id && e.is_active !== false);

  async function submit() {
    await send.mutateAsync({ to_employee_id: to, feedback_type: type, visibility, body });
    setOpen(false); setBody(""); setTo(defaultTo ?? "");
  }

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-flex">
        {trigger ?? <Button size="sm"><MessageSquarePlus className="h-4 w-4 mr-1" /> Give feedback</Button>}
      </span>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="feedback"
        mode="create"
        busy={send.isPending}
        submitDisabled={!to || !body.trim()}
        submitLabel="Send feedback"
        onSubmit={submit}
      >
        <WorkflowSheetSection number={1} title="Recipient & channel" subtitle="Pick who this is for, then choose the kind of feedback and how widely it should be shared.">
          <WorkflowField label="To" required>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger><SelectValue placeholder="Pick a coworker" /></SelectTrigger>
              <SelectContent className="max-h-72">
                {others.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.first_name} {e.last_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
          <WorkflowSheetGrid>
            <WorkflowField label="Type">
              <Select value={type} onValueChange={(v) => setType(v as FeedbackType)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="praise">Praise</SelectItem>
                  <SelectItem value="constructive">Constructive</SelectItem>
                  <SelectItem value="request">Request feedback</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
            <WorkflowField label="Visibility" hint="Manager and public feedback flow into the next review.">
              <Select value={visibility} onValueChange={(v) => setVisibility(v as FeedbackVisibility)}>
                <SelectTrigger><SelectValue /></SelectTrigger>
                <SelectContent>
                  <SelectItem value="private">Private (receiver only)</SelectItem>
                  <SelectItem value="manager">Share with their manager</SelectItem>
                  <SelectItem value="public">Public to organisation</SelectItem>
                </SelectContent>
              </Select>
            </WorkflowField>
          </WorkflowSheetGrid>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={2} title="Message" subtitle="Be specific. Reference behaviours and outcomes, not personality.">
          <WorkflowField label="Message" required>
            <Textarea rows={6} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Be specific. Reference behaviours, not personality." />
          </WorkflowField>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}

export function KudosComposer({ trigger, defaultTo }: { trigger?: React.ReactNode; defaultTo?: string }) {
  const [open, setOpen] = useState(false);
  const { employees } = useEmployees();
  const { currentEmployee } = useCurrentEmployee();
  const { send } = useKudos();
  const [to, setTo] = useState(defaultTo ?? "");
  const [body, setBody] = useState("");
  const [tag, setTag] = useState("");

  const others = employees.filter((e: any) => e.id !== currentEmployee?.id && e.is_active !== false);

  async function submit() {
    await send.mutateAsync({ to_employee_id: to, body, value_tag: tag || null });
    setOpen(false); setBody(""); setTag(""); setTo(defaultTo ?? "");
  }

  return (
    <>
      <span onClick={() => setOpen(true)} className="inline-flex">
        {trigger ?? <Button size="sm" variant="outline">🎉 Send kudos</Button>}
      </span>
      <TalentFormShell
        open={open}
        onOpenChange={setOpen}
        entity="feedback"
        mode="create"
        title="Send kudos"
        description="Public recognition visible to your organisation — kudos appear on the recipient's profile and the company feed."
        busy={send.isPending}
        submitDisabled={!to || !body.trim()}
        submitLabel="Send kudos"
        onSubmit={submit}
      >
        <WorkflowSheetSection number={1} title="Recipient">
          <WorkflowField label="To" required>
            <Select value={to} onValueChange={setTo}>
              <SelectTrigger><SelectValue placeholder="Pick a coworker" /></SelectTrigger>
              <SelectContent className="max-h-72">
                {others.map((e: any) => <SelectItem key={e.id} value={e.id}>{e.first_name} {e.last_name}</SelectItem>)}
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>

        <WorkflowSheetSection number={2} title="Why?" subtitle="Tie the kudos to a value to make recognition feel intentional.">
          <WorkflowField label="Message" required>
            <Textarea rows={4} value={body} onChange={(e) => setBody(e.target.value)} placeholder="Shipped the rapid-scan feature ahead of schedule." />
          </WorkflowField>
          <WorkflowField label="Value tag" hint="Optional — anchors the recognition to a company value.">
            <Select value={tag} onValueChange={setTag}>
              <SelectTrigger><SelectValue placeholder="Pick a value" /></SelectTrigger>
              <SelectContent>
                <SelectItem value="customer_first">Customer first</SelectItem>
                <SelectItem value="ownership">Ownership</SelectItem>
                <SelectItem value="craft">Craft</SelectItem>
                <SelectItem value="teamwork">Teamwork</SelectItem>
                <SelectItem value="learning">Learning</SelectItem>
              </SelectContent>
            </Select>
          </WorkflowField>
        </WorkflowSheetSection>
      </TalentFormShell>
    </>
  );
}
