/**
 * MyFeedback — employee-facing continuous feedback + kudos surface.
 *
 * Three tabs: Received, Sent, Kudos wall. Composer dialogs let the user
 * give feedback or send kudos. Acknowledging feedback marks it as read.
 */
import { useMemo } from "react";
import { useAuth } from "@/contexts/AuthContext";
import { useCurrentEmployee } from "@/hooks/useCurrentEmployee";
import { useContinuousFeedback, useKudos } from "@/hooks/useContinuousPerformance";
import { useEmployees } from "@/hooks/useEmployees";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { FeedbackComposer, KudosComposer } from "@/components/talent/FeedbackComposer";
import { Check, MessageSquare, Sparkles, ThumbsUp } from "lucide-react";
import { PageHeader, PageBody, EmptyState as DSEmptyState } from "@/design-system";

const TYPE_BADGE: Record<string, string> = {
  praise: "bg-emerald-500/10 text-emerald-700 border-emerald-200",
  constructive: "bg-amber-500/10 text-amber-700 border-amber-200",
  request: "bg-blue-500/10 text-blue-700 border-blue-200",
};

export default function MyFeedback() {
  const { user } = useAuth();
  const { currentEmployee } = useCurrentEmployee();
  const { employees } = useEmployees();
  const { feedback: received, acknowledge } = useContinuousFeedback({ toEmployeeId: currentEmployee?.id });
  const { feedback: sent } = useContinuousFeedback({ fromUserId: user?.id });
  const { kudos } = useKudos({ limit: 100 });

  const empName = useMemo(() => {
    const m = new Map<string, string>();
    employees.forEach((e: any) => m.set(e.id, `${e.first_name} ${e.last_name}`));
    return (id: string) => m.get(id) ?? id.slice(0, 8);
  }, [employees]);

  const unread = received.filter((f) => !f.acknowledged_at).length;

  if (!currentEmployee) {
    return (
      <>
        <PageHeader title="Feedback" description="Feedback needs a linked employee record." />
        <PageBody><DSEmptyState icon={MessageSquare} title="No linked employee record" description="Ask your HR admin to link your account." /></PageBody>
      </>
    );
  }

  return (
    <>
      <PageHeader
        title="Feedback"
        description="Continuous praise, constructive feedback, and kudos with your team."
        actions={<><FeedbackComposer /><KudosComposer /></>}
      />
      <PageBody>
      <Tabs defaultValue="received">
        <TabsList>
          <TabsTrigger value="received">Received {unread > 0 ? <Badge variant="destructive" className="ml-2 px-1.5">{unread}</Badge> : null}</TabsTrigger>
          <TabsTrigger value="sent">Sent</TabsTrigger>
          <TabsTrigger value="kudos">Kudos wall</TabsTrigger>
        </TabsList>

        <TabsContent value="received" className="space-y-2">
          {received.length === 0 ? (
            <EmptyState text="No feedback received yet. Ask a coworker for input — close colleagues give the best feedback." />
          ) : received.map((f) => (
            <Card key={f.id}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-sm font-medium">{f.is_anonymous ? "Anonymous" : empName(f.from_employee_id ?? "")}</span>
                    <Badge variant="outline" className={TYPE_BADGE[f.feedback_type]}>{f.feedback_type}</Badge>
                    <Badge variant="secondary" className="text-[10px]">{f.visibility}</Badge>
                    <span className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleDateString()}</span>
                  </div>
                  {!f.acknowledged_at ? (
                    <Button size="sm" variant="ghost" onClick={() => acknowledge.mutate(f.id)}><Check className="h-4 w-4 mr-1" /> Mark read</Button>
                  ) : <span className="text-xs text-muted-foreground">Read</span>}
                </div>
                <p className="text-sm whitespace-pre-wrap">{f.body}</p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="sent" className="space-y-2">
          {sent.length === 0 ? (
            <EmptyState text="You haven't sent any feedback yet." />
          ) : sent.map((f) => (
            <Card key={f.id}>
              <CardContent className="pt-4 space-y-2">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm">To <strong>{empName(f.to_employee_id)}</strong></span>
                  <Badge variant="outline" className={TYPE_BADGE[f.feedback_type]}>{f.feedback_type}</Badge>
                  <Badge variant="secondary" className="text-[10px]">{f.visibility}</Badge>
                  <span className="text-xs text-muted-foreground">{new Date(f.created_at).toLocaleDateString()}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{f.body}</p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>

        <TabsContent value="kudos" className="space-y-2">
          {kudos.length === 0 ? (
            <EmptyState text="Nobody has sent kudos yet. Be the first." />
          ) : kudos.map((k) => (
            <Card key={k.id}>
              <CardContent className="pt-4 space-y-1">
                <div className="flex items-center gap-2 flex-wrap text-sm">
                  <ThumbsUp className="h-4 w-4 text-emerald-600" />
                  <strong>{empName(k.from_employee_id ?? "")}</strong>
                  <span className="text-muted-foreground">→</span>
                  <strong>{empName(k.to_employee_id)}</strong>
                  {k.value_tag ? <Badge variant="outline" className="ml-1"><Sparkles className="h-3 w-3 mr-1" />{k.value_tag.replace(/_/g, " ")}</Badge> : null}
                  <span className="ml-auto text-xs text-muted-foreground">{new Date(k.created_at).toLocaleDateString()}</span>
                </div>
                <p className="text-sm whitespace-pre-wrap">{k.body}</p>
              </CardContent>
            </Card>
          ))}
        </TabsContent>
      </Tabs>
      </PageBody>
    </>
  );
}

function EmptyState({ text }: { text: string }) {
  return <Card><CardContent className="py-8 text-center text-sm text-muted-foreground">{text}</CardContent></Card>;
}