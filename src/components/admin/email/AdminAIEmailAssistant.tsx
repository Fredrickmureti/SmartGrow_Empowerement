import { useState } from "react";
import { sanitizeEmailHtml } from "@/lib/sanitizeEmailHtml";
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
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { 
  Sparkles, 
  Wand2, 
  Languages, 
  FileCode,
  Lightbulb,
  Mail,
  Megaphone,
  UserPlus,
  Wrench,
  Target,
  Loader2 
} from "lucide-react";
import { useAdminAIEmail, EmailType, EmailTone } from "@/hooks/useAdminAIEmail";

interface AdminAIEmailAssistantProps {
  currentSubject: string;
  currentBody: string;
  isHtml: boolean;
  onSubjectUpdate: (subject: string) => void;
  onBodyUpdate: (body: string) => void;
  onHtmlToggle: (isHtml: boolean) => void;
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

const emailTypes: { value: EmailType; label: string; icon: React.ReactNode; description: string }[] = [
  { value: "welcome", label: "Welcome Email", icon: <UserPlus className="h-4 w-4" />, description: "New user onboarding" },
  { value: "reengagement", label: "Re-engagement", icon: <Target className="h-4 w-4" />, description: "Win back inactive users" },
  { value: "announcement", label: "Feature Announcement", icon: <Megaphone className="h-4 w-4" />, description: "Share new features" },
  { value: "maintenance", label: "Maintenance Notice", icon: <Wrench className="h-4 w-4" />, description: "System updates" },
];

export function AdminAIEmailAssistant({
  currentSubject,
  currentBody,
  isHtml,
  onSubjectUpdate,
  onBodyUpdate,
  onHtmlToggle,
}: AdminAIEmailAssistantProps) {
  const { generateEmail, isLoading } = useAdminAIEmail();
  const [showGenerateDialog, setShowGenerateDialog] = useState(false);
  const [showCustomDialog, setShowCustomDialog] = useState(false);
  const [showPreview, setShowPreview] = useState(false);
  const [selectedEmailType, setSelectedEmailType] = useState<EmailType>("announcement");
  const [selectedTone, setSelectedTone] = useState<EmailTone>("professional");
  const [customPrompt, setCustomPrompt] = useState("");
  const [previewContent, setPreviewContent] = useState("");
  const [subjectSuggestions, setSubjectSuggestions] = useState<string[]>([]);
  const [showSubjectSuggestions, setShowSubjectSuggestions] = useState(false);

  const handleGenerateNew = async () => {
    const result = await generateEmail({
      action: "generate",
      emailType: selectedEmailType,
      tone: selectedTone,
      variables: { user_name: "{{user_name}}", platform_name: "AccrualFlow" },
    });

    if (result?.content) {
      setPreviewContent(result.content);
      setShowGenerateDialog(false);
      setShowPreview(true);
    }
  };

  const handleImprove = async () => {
    if (!currentBody.trim()) return;

    const result = await generateEmail({
      action: "improve",
      currentContent: currentBody,
      tone: selectedTone,
    });

    if (result?.content) {
      setPreviewContent(result.content);
      setShowPreview(true);
    }
  };

  const handleTranslate = async (language: string) => {
    if (!currentBody.trim()) return;

    const result = await generateEmail({
      action: "translate",
      currentContent: currentBody,
      targetLanguage: language,
    });

    if (result?.content) {
      setPreviewContent(result.content);
      setShowPreview(true);
    }
  };

  const handleBeautifyHtml = async () => {
    if (!currentBody.trim()) return;

    const result = await generateEmail({
      action: "html_beautify",
      currentContent: currentBody,
    });

    if (result?.content) {
      setPreviewContent(result.content);
      setShowPreview(true);
    }
  };

  const handleGetSubjectSuggestions = async () => {
    if (!currentBody.trim()) return;

    const result = await generateEmail({
      action: "subject_suggestions",
      currentContent: currentBody,
    });

    if (result?.subjects) {
      setSubjectSuggestions(result.subjects);
      setShowSubjectSuggestions(true);
    }
  };

  const handleCustomPrompt = async () => {
    if (!customPrompt.trim()) return;

    const result = await generateEmail({
      action: "generate",
      emailType: "custom",
      prompt: customPrompt,
      tone: selectedTone,
      variables: { user_name: "{{user_name}}", platform_name: "AccrualFlow" },
    });

    if (result?.content) {
      setPreviewContent(result.content);
      setShowCustomDialog(false);
      setCustomPrompt("");
      setShowPreview(true);
    }
  };

  const handleApplyContent = () => {
    onBodyUpdate(previewContent);
    // If the generated content is HTML, enable HTML mode
    if (previewContent.includes("<") && previewContent.includes(">")) {
      onHtmlToggle(true);
    }
    setShowPreview(false);
    setPreviewContent("");
  };

  const handleApplySubject = (subject: string) => {
    // Clean up the subject (remove quotes, numbers, emojis at the start if needed)
    const cleanSubject = subject.replace(/^[\d\.\)\s]+/, "").replace(/^["']|["']$/g, "").trim();
    onSubjectUpdate(cleanSubject);
    setShowSubjectSuggestions(false);
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
          <DropdownMenuLabel>Generate Email</DropdownMenuLabel>
          <DropdownMenuSeparator />
          
          <DropdownMenuItem onClick={() => setShowGenerateDialog(true)}>
            <Mail className="mr-2 h-4 w-4" />
            Generate from Template
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={() => setShowCustomDialog(true)}>
            <Wand2 className="mr-2 h-4 w-4" />
            Custom AI Prompt
          </DropdownMenuItem>
          
          <DropdownMenuSeparator />
          <DropdownMenuLabel>Improve Content</DropdownMenuLabel>
          <DropdownMenuSeparator />
          
          <DropdownMenuItem onClick={handleImprove} disabled={!currentBody.trim()}>
            <Sparkles className="mr-2 h-4 w-4" />
            Improve Writing
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={handleBeautifyHtml} disabled={!currentBody.trim()}>
            <FileCode className="mr-2 h-4 w-4" />
            Convert to HTML
          </DropdownMenuItem>
          
          <DropdownMenuItem onClick={handleGetSubjectSuggestions} disabled={!currentBody.trim()}>
            <Lightbulb className="mr-2 h-4 w-4" />
            Suggest Subject Lines
          </DropdownMenuItem>
          
          <DropdownMenuSeparator />
          
          <DropdownMenuSub>
            <DropdownMenuSubTrigger disabled={!currentBody.trim()}>
              <Languages className="mr-2 h-4 w-4" />
              Translate to...
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>
              {languages.map((lang) => (
                <DropdownMenuItem 
                  key={lang.code}
                  onClick={() => handleTranslate(lang.name)}
                >
                  {lang.name}
                </DropdownMenuItem>
              ))}
            </DropdownMenuSubContent>
          </DropdownMenuSub>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* Generate from Template Dialog */}
      <Dialog open={showGenerateDialog} onOpenChange={setShowGenerateDialog}>
        <DialogContent className="max-w-lg">
          <DialogHeader>
            <DialogTitle>Generate Email with AI</DialogTitle>
            <DialogDescription>
              Choose a template type and tone to generate your email
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-6">
            <div className="space-y-3">
              <Label>Email Type</Label>
              <div className="grid grid-cols-2 gap-2">
                {emailTypes.map((type) => (
                  <div
                    key={type.value}
                    onClick={() => setSelectedEmailType(type.value)}
                    className={`flex items-start gap-3 p-3 rounded-lg border cursor-pointer transition-colors ${
                      selectedEmailType === type.value
                        ? "border-primary bg-primary/5"
                        : "hover:bg-muted/50"
                    }`}
                  >
                    <div className="mt-0.5">{type.icon}</div>
                    <div>
                      <p className="font-medium text-sm">{type.label}</p>
                      <p className="text-xs text-muted-foreground">{type.description}</p>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            <div className="space-y-3">
              <Label>Tone</Label>
              <RadioGroup
                value={selectedTone}
                onValueChange={(v) => setSelectedTone(v as EmailTone)}
                className="grid grid-cols-2 gap-2"
              >
                {[
                  { value: "professional", label: "Professional" },
                  { value: "friendly", label: "Friendly" },
                  { value: "marketing", label: "Marketing" },
                  { value: "urgent", label: "Urgent" },
                ].map((tone) => (
                  <div key={tone.value} className="flex items-center space-x-2">
                    <RadioGroupItem value={tone.value} id={tone.value} />
                    <Label htmlFor={tone.value} className="cursor-pointer">
                      {tone.label}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowGenerateDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleGenerateNew} disabled={isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Sparkles className="mr-2 h-4 w-4" />
                  Generate
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Custom Prompt Dialog */}
      <Dialog open={showCustomDialog} onOpenChange={setShowCustomDialog}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Custom AI Email</DialogTitle>
            <DialogDescription>
              Describe the email you want to create
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4">
            <div className="space-y-2">
              <Label htmlFor="customPrompt">Your Instructions</Label>
              <Textarea
                id="customPrompt"
                placeholder="e.g., Write an email announcing our new inventory management feature. Make it exciting and include a call-to-action to try it out..."
                value={customPrompt}
                onChange={(e) => setCustomPrompt(e.target.value)}
                rows={4}
              />
            </div>
            <div className="space-y-2">
              <Label>Tone</Label>
              <RadioGroup
                value={selectedTone}
                onValueChange={(v) => setSelectedTone(v as EmailTone)}
                className="flex gap-4"
              >
                {["professional", "friendly", "marketing", "urgent"].map((tone) => (
                  <div key={tone} className="flex items-center space-x-2">
                    <RadioGroupItem value={tone} id={`custom-${tone}`} />
                    <Label htmlFor={`custom-${tone}`} className="capitalize cursor-pointer">
                      {tone}
                    </Label>
                  </div>
                ))}
              </RadioGroup>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowCustomDialog(false)}>
              Cancel
            </Button>
            <Button onClick={handleCustomPrompt} disabled={!customPrompt.trim() || isLoading}>
              {isLoading ? (
                <>
                  <Loader2 className="mr-2 h-4 w-4 animate-spin" />
                  Generating...
                </>
              ) : (
                <>
                  <Wand2 className="mr-2 h-4 w-4" />
                  Generate
                </>
              )}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Preview Dialog */}
      <Dialog open={showPreview} onOpenChange={setShowPreview}>
        <DialogContent className="max-w-3xl max-h-[80vh]">
          <DialogHeader>
            <DialogTitle>AI Generated Content</DialogTitle>
            <DialogDescription>
              Review the generated content before applying
            </DialogDescription>
          </DialogHeader>
          <div className="overflow-y-auto max-h-[50vh]">
            {previewContent.includes("<") && previewContent.includes(">") ? (
              <div 
                className="border rounded-lg p-4 bg-white"
                dangerouslySetInnerHTML={{ __html: sanitizeEmailHtml(previewContent) }}
              />
            ) : (
              <div className="p-4 rounded-md bg-muted text-sm whitespace-pre-wrap font-mono">
                {previewContent}
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowPreview(false)}>
              Cancel
            </Button>
            <Button onClick={handleApplyContent}>
              Apply Content
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      {/* Subject Suggestions Dialog */}
      <Dialog open={showSubjectSuggestions} onOpenChange={setShowSubjectSuggestions}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Subject Line Suggestions</DialogTitle>
            <DialogDescription>
              Click on a suggestion to use it
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            {subjectSuggestions.map((subject, index) => (
              <div
                key={index}
                onClick={() => handleApplySubject(subject)}
                className="p-3 rounded-lg border hover:bg-muted/50 cursor-pointer transition-colors"
              >
                <p className="text-sm">{subject}</p>
              </div>
            ))}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowSubjectSuggestions(false)}>
              Cancel
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
