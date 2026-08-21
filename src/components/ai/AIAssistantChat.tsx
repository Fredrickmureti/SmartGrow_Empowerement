import { useState, useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { useAIAssistant } from "@/hooks/useAIAssistant";
import { useBusinesses } from "@/hooks/useBusinesses";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Sheet, SheetContent, SheetHeader, SheetTitle } from "@/components/ui/sheet";
import { Sparkles, Send, Loader2, Trash2, Bot, ArrowRight, Wrench, Package } from "lucide-react";
import { cn } from "@/lib/utils";
import { MarkdownRenderer } from "@/components/common/MarkdownRenderer";
import { getContextualPrompts } from "@/lib/ai/contextualPrompts";
import { ROUTE_CATALOG } from "@/lib/ai/routeCatalog";
import type { ActionBlock } from "@/lib/ai/actionBlocks";
import { dispatchMissingMappings } from "@/hooks/payroll/usePayrollGlReadiness";
import { supabase } from "@/integrations/supabase/client";

interface AIAssistantChatProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  currentPath: string;
}

export function AIAssistantChat({ open, onOpenChange, currentPath }: AIAssistantChatProps) {
  const { messages, isLoading, sendChatMessage, clearChat } = useAIAssistant();
  const { currentBusiness } = useBusinesses();
  const [input, setInput] = useState("");

  const contextualPrompts = getContextualPrompts(currentPath);

  // Clear chat when business context changes
  useEffect(() => {
    clearChat();
  }, [currentBusiness?.id]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!input.trim() || isLoading) return;
    const message = input.trim();
    setInput("");
    await sendChatMessage(message, currentPath);
  };

  const handlePromptClick = (text: string) => {
    sendChatMessage(text, currentPath);
  };

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md p-0 flex flex-col">
        <SheetHeader className="p-4 border-b bg-gradient-to-r from-primary/5 to-primary/10">
          <div className="flex items-center justify-between">
            <SheetTitle className="flex items-center gap-2">
              <div className="h-8 w-8 rounded-lg bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center">
                <Bot className="h-4 w-4 text-primary-foreground" />
              </div>
              <div className="flex flex-col items-start">
                <span className="text-base font-semibold">AccrualFlow AI</span>
                <span className="text-xs text-muted-foreground font-normal">Your Financial Assistant</span>
              </div>
            </SheetTitle>
            {messages.length > 0 && (
              <Button variant="ghost" size="sm" onClick={clearChat} className="h-8 w-8 p-0">
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        </SheetHeader>

        <ScrollArea className="flex-1 p-4 bg-gradient-to-b from-background to-muted/20">
          {messages.length === 0 ? (
            <div className="flex flex-col items-center justify-center h-full text-center py-8">
              <div className="h-16 w-16 rounded-2xl bg-gradient-to-br from-primary/20 to-primary/10 flex items-center justify-center mb-4">
                <Sparkles className="h-8 w-8 text-primary" />
              </div>
              <h3 className="font-semibold text-lg mb-1">Welcome to AccrualFlow AI</h3>
              <p className="text-sm text-muted-foreground mb-6 max-w-[280px]">
                Your intelligent assistant for financial insights, accounting guidance, and data analysis.
              </p>
              <div className="grid gap-2 w-full max-w-xs">
                {contextualPrompts.map(({ text, icon: Icon }) => (
                  <Button
                    key={text}
                    variant="outline"
                    size="sm"
                    className="text-xs h-auto py-2.5 px-3 text-left justify-start gap-2 hover:bg-primary/5 hover:border-primary/30 transition-colors"
                    onClick={() => handlePromptClick(text)}
                    disabled={isLoading}
                  >
                    <Icon className="h-3.5 w-3.5 text-primary flex-shrink-0" />
                    {text}
                  </Button>
                ))}
              </div>
            </div>
          ) : (
            <div className="space-y-4">
              {messages.map((message, index) => (
                <div
                  key={index}
                  className={cn(
                    "flex",
                    message.role === "user" ? "justify-end" : "justify-start"
                  )}
                >
                  {message.role === "assistant" && (
                    <div className="h-7 w-7 rounded-full bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center mr-2 flex-shrink-0 mt-0.5">
                      <Bot className="h-3.5 w-3.5 text-primary-foreground" />
                    </div>
                  )}
                  <div
                    className={cn(
                      "max-w-[80%] rounded-2xl px-4 py-2.5",
                      message.role === "user"
                        ? "bg-primary text-primary-foreground rounded-br-md"
                        : "bg-card border shadow-sm rounded-bl-md"
                    )}
                  >
                    {message.role === "assistant" ? (
                      <>
                        <MarkdownRenderer content={message.content} className="text-sm" />
                        {message.actions && message.actions.length > 0 && (
                          <ActionBlocks actions={message.actions} onClose={() => onOpenChange(false)} />
                        )}
                      </>
                    ) : (
                      <p className="text-sm whitespace-pre-wrap">{message.content}</p>
                    )}
                  </div>
                </div>
              ))}
              {isLoading &&
                (messages[messages.length - 1]?.role === "user" ||
                  !messages[messages.length - 1]?.content) && (
                <div className="flex justify-start">
                  <div className="h-7 w-7 rounded-full bg-gradient-to-br from-primary to-primary/80 flex items-center justify-center mr-2 flex-shrink-0">
                    <Bot className="h-3.5 w-3.5 text-primary-foreground" />
                  </div>
                  <div className="bg-card border shadow-sm rounded-2xl rounded-bl-md px-4 py-3">
                    <div className="flex gap-1">
                      <span className="h-2 w-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "0ms" }}></span>
                      <span className="h-2 w-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "150ms" }}></span>
                      <span className="h-2 w-2 bg-primary/60 rounded-full animate-bounce" style={{ animationDelay: "300ms" }}></span>
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </ScrollArea>

        <form onSubmit={handleSubmit} className="p-4 border-t bg-background/80 backdrop-blur-sm">
          <div className="flex gap-2">
            <Input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              placeholder="Ask AccrualFlow AI..."
              disabled={isLoading}
              className="rounded-full bg-muted/50 border-muted-foreground/20 focus-visible:ring-primary/30"
            />
            <Button
              type="submit"
              size="icon"
              disabled={isLoading || !input.trim()}
              className="rounded-full h-10 w-10 bg-gradient-to-br from-primary to-primary/80 hover:from-primary/90 hover:to-primary/70 transition-all flex-shrink-0"
            >
              {isLoading ? (
                <Loader2 className="h-4 w-4 animate-spin" />
              ) : (
                <Send className="h-4 w-4" />
              )}
            </Button>
          </div>
        </form>
      </SheetContent>
    </Sheet>
  );
}

function ActionBlocks({ actions, onClose }: { actions: ActionBlock[]; onClose: () => void }) {
  const navigate = useNavigate();

  const handle = (a: ActionBlock) => {
    if (a.type === "open_path") {
      const entry = ROUTE_CATALOG[a.path_id];
      if (!entry) return;
      navigate(entry.path);
      onClose();
      return;
    }
    if (a.type === "fix_gl_mappings") {
      // If the AI provided a specific blocked run, fetch its run-specific
      // missing mappings so the dialog opens with exactly those rows
      // (matching the contract used by post-payroll-gl events).
      if (a.payroll_run_id) {
        (async () => {
          try {
            const { data } = await supabase.rpc(
              "payroll_required_gl_mappings_for_run" as any,
              { p_run_id: a.payroll_run_id },
            );
            const missing = ((data as any[]) || [])
              .filter((r) => !r.is_mapped)
              .map((r) => ({
                setting_key: r.setting_key,
                label: r.label,
                rule_code: r.rule_code ?? null,
                kind: r.kind,
                suggested_account_id: r.suggested_account_id ?? null,
                suggested_account_label: r.suggested_account_label ?? null,
              }));
            dispatchMissingMappings({
              message: `Resolve missing payroll GL mappings for this run before posting.`,
              missing,
            });
          } catch {
            dispatchMissingMappings({
              message: "Resolve missing payroll GL mappings before posting.",
              missing: [],
            });
          } finally {
            onClose();
          }
        })();
        return;
      }
      dispatchMissingMappings({
        message: "Resolve missing payroll GL mappings before posting.",
        missing: [],
      });
      onClose();
      return;
    }
    if (a.type === "open_install_dialog") {
      navigate(`/apps/${a.app_id}/activate`);
      onClose();
      return;
    }
  };

  return (
    <div className="mt-3 flex flex-wrap gap-2">
      {actions.map((a, i) => {
        const Icon = a.type === "fix_gl_mappings" ? Wrench : a.type === "open_install_dialog" ? Package : ArrowRight;
        return (
          <Button
            key={i}
            size="sm"
            variant="secondary"
            onClick={() => handle(a)}
            className="h-7 text-xs"
          >
            <Icon className="mr-1.5 h-3.5 w-3.5" />
            {a.label}
          </Button>
        );
      })}
    </div>
  );
}
