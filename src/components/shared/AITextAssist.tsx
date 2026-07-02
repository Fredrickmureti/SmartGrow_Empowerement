import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Sparkles, Loader2, Check, RefreshCw, Wand2 } from "lucide-react";
import { useDocumentAI, DocumentType, FieldType, AIAction } from "@/hooks/useDocumentAI";
import { cn } from "@/lib/utils";

interface AITextAssistProps {
  fieldType: FieldType;
  documentType: DocumentType;
  currentValue: string;
  onApply: (text: string) => void;
  customerName?: string;
  documentNumber?: string;
  lineItemsSummary?: string;
  totalAmount?: number;
  currency?: string;
  disabled?: boolean;
}

export function AITextAssist({
  fieldType,
  documentType,
  currentValue,
  onApply,
  customerName,
  documentNumber,
  lineItemsSummary,
  totalAmount,
  currency,
  disabled,
}: AITextAssistProps) {
  const [open, setOpen] = useState(false);
  const [previewText, setPreviewText] = useState<string | null>(null);

  const { generateText, isLoading } = useDocumentAI({
    documentType,
    customerName,
    documentNumber,
    lineItemsSummary,
    totalAmount,
    currency,
  });

  const handleGenerate = async (action: AIAction) => {
    const result = await generateText(action, fieldType, currentValue);
    if (result) {
      setPreviewText(result);
    }
  };

  const handleApply = () => {
    if (previewText) {
      onApply(previewText);
      setPreviewText(null);
      setOpen(false);
    }
  };

  const handleClose = () => {
    setPreviewText(null);
    setOpen(false);
  };

  const fieldLabel = fieldType === "notes" ? "Notes" : "Terms & Conditions";
  const generateLabel = fieldType === "notes" ? "Generate professional notes" : "Generate terms & conditions";

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled || isLoading}
          className="h-7 px-2 text-muted-foreground hover:text-primary"
        >
          {isLoading ? (
            <Loader2 className="h-4 w-4 animate-spin" />
          ) : (
            <Sparkles className="h-4 w-4" />
          )}
          <span className="ml-1 text-xs">AI</span>
        </Button>
      </PopoverTrigger>
      <PopoverContent className="w-96" align="end">
        <div className="space-y-4">
          <div className="space-y-2">
            <h4 className="font-medium text-sm">AI Writing Assistant</h4>
            <p className="text-xs text-muted-foreground">
              Generate professional {fieldLabel.toLowerCase()} for your {documentType.replace("_", " ")}
            </p>
          </div>

          {!previewText ? (
            <div className="space-y-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                className="w-full justify-start"
                onClick={() => handleGenerate("generate")}
                disabled={isLoading}
              >
                {isLoading ? (
                  <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                ) : (
                  <Wand2 className="h-4 w-4 mr-2" />
                )}
                {generateLabel}
              </Button>

              {currentValue && currentValue.trim().length > 0 && (
                <>
                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => handleGenerate("improve")}
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <RefreshCw className="h-4 w-4 mr-2" />
                    )}
                    Improve current text
                  </Button>

                  <Button
                    type="button"
                    variant="outline"
                    size="sm"
                    className="w-full justify-start"
                    onClick={() => handleGenerate("professional")}
                    disabled={isLoading}
                  >
                    {isLoading ? (
                      <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                    ) : (
                      <Sparkles className="h-4 w-4 mr-2" />
                    )}
                    Make more professional
                  </Button>
                </>
              )}
            </div>
          ) : (
            <div className="space-y-3">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Preview</label>
                <Textarea
                  value={previewText}
                  onChange={(e) => setPreviewText(e.target.value)}
                  rows={6}
                  className="text-sm resize-none"
                />
              </div>

              <div className="flex gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="flex-1"
                  onClick={handleClose}
                >
                  Cancel
                </Button>
                <Button
                  type="button"
                  size="sm"
                  className="flex-1"
                  onClick={handleApply}
                >
                  <Check className="h-4 w-4 mr-1" />
                  Apply
                </Button>
              </div>

              <Button
                type="button"
                variant="ghost"
                size="sm"
                className="w-full text-xs"
                onClick={() => {
                  setPreviewText(null);
                }}
              >
                <RefreshCw className="h-3 w-3 mr-1" />
                Try again
              </Button>
            </div>
          )}

          {customerName && (
            <p className="text-xs text-muted-foreground border-t pt-2">
              Context: {customerName}
              {totalAmount && currency ? ` • ${currency} ${totalAmount.toLocaleString()}` : ""}
            </p>
          )}
        </div>
      </PopoverContent>
    </Popover>
  );
}
