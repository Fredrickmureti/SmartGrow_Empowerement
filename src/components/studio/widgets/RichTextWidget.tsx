import { useState, useRef, useCallback } from "react";
import DOMPurify from "dompurify";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Separator } from "@/components/ui/separator";
import { 
  Bold, Italic, Underline, List, ListOrdered, Link, 
  AlignLeft, AlignCenter, AlignRight, Code, Eye, Pencil 
} from "lucide-react";
import { EntityFieldConfig } from "@/hooks/useEntityFields";

// Strict allow-list sanitizer: blocks scripts, event handlers, javascript: URLs.
const sanitizeHtml = (html: string): string =>
  DOMPurify.sanitize(html, {
    ALLOWED_TAGS: [
      "p", "br", "b", "i", "u", "strong", "em", "s", "strike",
      "ul", "ol", "li", "a", "h1", "h2", "h3", "h4", "h5", "h6",
      "blockquote", "code", "pre", "span", "div",
    ],
    ALLOWED_ATTR: ["href", "target", "rel", "class"],
    ALLOWED_URI_REGEXP: /^(?:https?:|mailto:|tel:|#|\/)/i,
  });

interface RichTextWidgetProps {
  field: EntityFieldConfig;
  value: string | null;
  onChange: (value: string | null) => void;
  disabled?: boolean;
}

/**
 * Rich text widget using contentEditable div.
 * Stores HTML in field_value. Supports basic formatting without heavy dependencies.
 */
export function RichTextWidget({ field, value, onChange, disabled }: RichTextWidgetProps) {
  const [mode, setMode] = useState<"edit" | "preview" | "source">("edit");
  const editorRef = useRef<HTMLDivElement>(null);

  const execCommand = (command: string, val?: string) => {
    document.execCommand(command, false, val);
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      const clean = sanitizeHtml(html);
      onChange(clean === "<br>" || clean === "" ? null : clean);
    }
  };

  const handleInput = useCallback(() => {
    if (editorRef.current) {
      const html = editorRef.current.innerHTML;
      const clean = sanitizeHtml(html);
      onChange(clean === "<br>" || clean === "" ? null : clean);
    }
  }, [onChange]);

  if (disabled) {
    return (
      <div
        className="min-h-[100px] rounded-md border bg-muted/30 px-3 py-2 text-sm prose prose-sm max-w-none"
        dangerouslySetInnerHTML={{
          __html: value
            ? sanitizeHtml(value)
            : '<span class="text-muted-foreground">No content</span>',
        }}
      />
    );
  }

  return (
    <div className="rounded-md border overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center gap-0.5 p-1 bg-muted/30 border-b flex-wrap">
        <Button
          type="button" variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => execCommand("bold")}
          title="Bold"
        >
          <Bold className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button" variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => execCommand("italic")}
          title="Italic"
        >
          <Italic className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button" variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => execCommand("underline")}
          title="Underline"
        >
          <Underline className="h-3.5 w-3.5" />
        </Button>
        <Separator orientation="vertical" className="h-5 mx-0.5" />
        <Button
          type="button" variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => execCommand("insertUnorderedList")}
          title="Bullet list"
        >
          <List className="h-3.5 w-3.5" />
        </Button>
        <Button
          type="button" variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => execCommand("insertOrderedList")}
          title="Numbered list"
        >
          <ListOrdered className="h-3.5 w-3.5" />
        </Button>
        <Separator orientation="vertical" className="h-5 mx-0.5" />
        <Button
          type="button" variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => {
            const url = prompt("Enter URL:");
            if (url) execCommand("createLink", url);
          }}
          title="Insert link"
        >
          <Link className="h-3.5 w-3.5" />
        </Button>
        <div className="flex-1" />
        <Button
          type="button" variant="ghost" size="icon" className="h-7 w-7"
          onClick={() => setMode(mode === "source" ? "edit" : "source")}
          title={mode === "source" ? "Visual editor" : "HTML source"}
        >
          {mode === "source" ? <Eye className="h-3.5 w-3.5" /> : <Code className="h-3.5 w-3.5" />}
        </Button>
      </div>

      {/* Editor area */}
      {mode === "source" ? (
        <Textarea
          value={value || ""}
          onChange={(e) => onChange(sanitizeHtml(e.target.value) || null)}
          placeholder={field.placeholder || "Enter HTML..."}
          rows={6}
          className="border-0 rounded-none font-mono text-xs focus-visible:ring-0"
        />
      ) : (
        <div
          ref={editorRef}
          contentEditable
          className="min-h-[100px] px-3 py-2 text-sm outline-none prose prose-sm max-w-none focus:ring-0"
          onInput={handleInput}
          dangerouslySetInnerHTML={{ __html: sanitizeHtml(value || "") }}
          data-placeholder={field.placeholder || "Start typing..."}
        />
      )}
    </div>
  );
}
