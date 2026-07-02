/**
 * TaskComments — chatter thread for a project task.
 *
 * Backed by `task_comments` (RLS via can_access_project, count maintained by
 * trigger on project_tasks.comment_count). Author actions: post + delete-own.
 */
import { useState } from "react";
import { Avatar, AvatarFallback } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Trash2, MessageSquare } from "lucide-react";
import { formatDistanceToNow } from "date-fns";
import { useTaskComments } from "@/hooks/projects";
import { useAuth } from "@/contexts/AuthContext";

interface TaskCommentsProps {
  taskId: string | null;
}

/**
 * Minimal @mention renderer — highlights `@token` runs so Stage-10
 * notifications can pick them up later without a schema change.
 */
function renderWithMentions(body: string) {
  const parts = body.split(/(@[A-Za-z0-9_.-]+)/g);
  return parts.map((p, i) =>
    p.startsWith("@") ? (
      <span key={i} className="text-primary font-medium">{p}</span>
    ) : (
      <span key={i}>{p}</span>
    ),
  );
}

export function TaskComments({ taskId }: TaskCommentsProps) {
  const { user } = useAuth();
  const { comments, isLoading, addComment, deleteComment } = useTaskComments(taskId);
  const [draft, setDraft] = useState("");
  const [submitting, setSubmitting] = useState(false);

  const handlePost = async () => {
    if (!draft.trim()) return;
    setSubmitting(true);
    try {
      await addComment(draft);
      setDraft("");
    } finally {
      setSubmitting(false);
    }
  };

  if (!taskId) return null;

  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 text-sm font-medium">
        <MessageSquare className="h-4 w-4 text-muted-foreground" />
        Comments {comments.length > 0 && (
          <span className="text-xs text-muted-foreground font-normal">
            ({comments.length})
          </span>
        )}
      </div>

      {/* Composer */}
      <div className="space-y-2">
        <Textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a comment…"
          rows={2}
          onKeyDown={(e) => {
            if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
              e.preventDefault();
              void handlePost();
            }
          }}
        />
        <div className="flex justify-end">
          <Button
            size="sm"
            onClick={handlePost}
            disabled={submitting || !draft.trim()}
          >
            {submitting ? "Posting…" : "Post"}
          </Button>
        </div>
      </div>

      {/* Thread */}
      {isLoading ? (
        <p className="text-xs text-muted-foreground">Loading…</p>
      ) : comments.length === 0 ? (
        <p className="text-xs text-muted-foreground">No comments yet.</p>
      ) : (
        <div className="space-y-3">
          {comments.map((c) => {
            const isMine = c.author_id === user?.id;
            return (
              <div key={c.id} className="flex gap-3">
                <Avatar className="h-7 w-7 shrink-0">
                  <AvatarFallback className="text-xs">
                    {(c.author_id || "?").slice(0, 2).toUpperCase()}
                  </AvatarFallback>
                </Avatar>
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <span className="font-medium text-foreground">
                      {isMine ? "You" : "Member"}
                    </span>
                    <span>·</span>
                    <span>
                      {formatDistanceToNow(new Date(c.created_at), { addSuffix: true })}
                    </span>
                    {isMine && (
                      <button
                        onClick={() => deleteComment(c.id)}
                        className="ml-auto hover:text-destructive"
                        aria-label="Delete comment"
                      >
                        <Trash2 className="h-3 w-3" />
                      </button>
                    )}
                  </div>
                  <p className="text-sm whitespace-pre-wrap mt-1 break-words">
                    {renderWithMentions(c.body)}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
