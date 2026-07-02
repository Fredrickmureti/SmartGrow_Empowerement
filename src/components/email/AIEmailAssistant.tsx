import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import { 
  Sparkles, 
  Briefcase, 
  Heart, 
  Minimize2, 
  Maximize2, 
  Languages, 
  Wand2,
  Loader2 
} from "lucide-react";
import { useAIEmailWriter, EmailAIAction } from "@/hooks/useAIEmailWriter";

interface AIEmailAssistantProps {
  currentMessage: string;
  onMessageUpdate: (message: string) => void;
  context: {
    documentType: string;
    documentNumber: string;
    recipientName?: string;
    total?: number;
    currency?: string;
    dueDate?: string;
    organizationName?: string;
  };
}

const languages = [
  { code: "es", name: "Spanish" },
  { code: "fr", name: "French" },
  { code: "de", name: "German" },
  { code: "pt", name: "Portuguese" },
  { code: "it", name: "Italian" },
  { code: "zh", name: "Chinese" },
  { code: "ja", name: "Japanese" },
  { code: "ar", name: "Arabic" },
  { code: "sw", name: "Swahili" },
  { code: "hi", name: "Hindi" },
];

export function AIEmailAssistant({ currentMessage, onMessageUpdate, context }: AIEmailAssistantProps) {
  const { improveEmail, isLoading } = useAIEmailWriter();
  const [showCustomDialog, setShowCustomDialog] = useState(false);
  const [customInstruction, setCustomInstruction] = useState("");
  const [previewMessage, setPreviewMessage] = useState<string | null>(null);
  const [showPreview, setShowPreview] = useState(false);
  const [pendingAction, setPendingAction] = useState<{
    action: EmailAIAction;
    language?: string;
  } | null>(null);

  const handleAction = async (action: EmailAIAction, language?: string) => {
    const result = await improveEmail(
      currentMessage,
      action,
      context,
      action === "custom" ? customInstruction : undefined,
      language
    );

    if (result) {
      setPreviewMessage(result);
      setShowPreview(true);
      setPendingAction({ action, language });
    }
  };

  const handleApply = () => {
    if (previewMessage) {
      onMessageUpdate(previewMessage);
      setShowPreview(false);
      setPreviewMessage(null);
      setPendingAction(null);
    }
  };

  const handleCustomSubmit = async () => {
    setShowCustomDialog(false);
    await handleAction("custom");
    setCustomInstruction("");
  };

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button 
            variant="outline" 
            size="sm" 
            className="gap-2"
            disabled={isLoading}
          >
            {isLoading ? (
              <Loader2 className="h-4 w-4 animate-spin" />
            ) : (
              <Sparkles className="h-4 w-4" />
            )}
            AI Assist
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuLabel>Improve with AI</DropdownMenuLabel>
          <DropdownMenuSeparator />
          
          <DropdownMenuItem onClick={() => handleAction("professionalize")}>
            <Briefcase className="mr-2 h-4 w-4" />
            Professionalize
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={() => handleAction("friendly")}>
            <Heart className="mr-2 h-4 w-4" />
            Make Friendly
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={() => handleAction("shorten")}>
            <Minimize2 className="mr-2 h-4 w-4" />
            Shorten
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={() => handleAction("expand")}>
            <Maximize2 className="mr-2 h-4 w-4" />
            Expand
          </DropdownMenuItem>
          
          <DropdownMenuSeparator />
          
          <DropdownMenuSub>
            <DropdownMenuSubTrigger>
              <Languages className="mr-2 h-4 w-4" />
              Translate to...
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {languages.map((lang) => (
                <DropdownMenuItem 
                  key={lang.code}
                  onClick={() => handleAction("translate", lang.name)}
                >
                  {lang.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
          
          <DropdownMenuSeparator />
          
          <DropdownMenuItem onClick={() => setShowCustomDialog(true)}>
            <Wand2 className="mr-2 h-4 w-4" />
            Custom instruction...
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Custom Instruction Dialog */}
      <Dialog open={showCustomDialog} onOpenChange={setShowCustomDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom AI Instruction</DialogTitle>
            <DialogDescription>
              Tell the AI how you'd like to improve your email
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="customInstruction">Instruction</Label>
              <Textarea
                id="customInstruction"
                placeholder="e.g., Add urgency about the payment deadline, or include information about our discount for early payment..."
                value={customInstruction}
                onChange={(e) => setCustomInstruction(e.target.value)}
                rows={4}
              />
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCustomDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCustomSubmit} disabled={!customInstruction.trim()}>
              <Sparkles className="mr-2 h-4 w-4" />
              Apply
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-2xl">
          <DialogHeader>
            <DialogTitle>AI Suggested Message</DialogTitle>
            <DialogDescription>
              Review the AI-improved message before applying it
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label>Original</Label>
              <div className="p-3 rounded-md bg-muted text-sm whitespace-pre-wrap max-h-32 overflow-y-auto">
                {currentMessage}
              </div>
            </div>
            <div className="space-y-2">
              <Label className="flex items-center gap-2">
                <Sparkles className="h-4 w-4 text-primary" />
                Improved
              </Label>
              <div className="p-3 rounded-md bg-primary/5 border border-primary/20 text-sm whitespace-pre-wrap max-h-48 overflow-y-auto">
                {previewMessage}
              </div>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPreview(false)}>
              Cancel
            </Button>
            <Button onClick={handleApply}>
              Apply Changes
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
