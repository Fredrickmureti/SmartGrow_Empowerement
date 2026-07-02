/**
 * TokenAwareTextarea — chip-based template body editor.
 *
 * The user never sees `{{token.path}}` braces. Tokens render as inline
 * pill chips with human labels (e.g. "Employee — Full Name"); typing is
 * plain text. On every change the editor serializes the DOM back to a
 * brace-string so the storage shape and runtime renderer remain
 * unchanged.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Plus, Search, Variable } from "lucide-react";
import { useTokenRegistry } from "../hooks";
import { humanizeToken } from "../lib/humanizeToken";

const TOKEN_REGEX = /\{\{\s*([a-zA-Z0-9_.]+)\s*\}\}/g;
const MALFORMED_REGEX = /\{\{[^}]*?\}\}/g;

interface Props {
  id?: string;
  packId?: string | null;
  value: string;
  onChange: (next: string) => void;
  rows?: number;
  placeholder?: string;
}

type ChipMeta = {
  path: string;
  label: string;
  status: "registered" | "unknown";
};

export function TokenAwareTextarea({ id, packId, value, onChange, rows = 10, placeholder }: Props) {
  const { data: registry } = useTokenRegistry(packId ?? null);
  const editorRef = useRef<HTMLDivElement | null>(null);
  const lastSerialized = useRef<string>("");
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");

  const registered = useMemo(
    () => new Map((registry ?? []).map((t) => [t.token_path, t] as const)),
    [registry],
  );

  const chipMeta = (path: string): ChipMeta => {
    const t = registered.get(path);
    return {
      path,
      label: humanizeToken(path, t?.description ?? null),
      status: t ? "registered" : "unknown",
    };
  };

  // ── DOM <-> string serialization ────────────────────────────────
  const buildChip = (path: string): HTMLSpanElement => {
    const meta = chipMeta(path);
    const el = document.createElement("span");
    el.setAttribute("data-token", path);
    el.setAttribute("contenteditable", "false");
    el.className = [
      "inline-flex items-center gap-1 px-1.5 py-0.5 mx-0.5 rounded-md text-[11px] font-medium select-none cursor-default align-baseline border",
      meta.status === "registered"
        ? "bg-primary/10 text-primary border-primary/30"
        : "bg-amber-500/10 text-amber-700 dark:text-amber-300 border-amber-500/40",
    ].join(" ");
    el.title = `${meta.path}${meta.status === "unknown" ? " (not in token registry)" : ""}`;
    el.textContent = meta.label;
    return el;
  };

  const renderToDom = (str: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.innerHTML = "";
    let last = 0;
    let m: RegExpExecArray | null;
    TOKEN_REGEX.lastIndex = 0;
    while ((m = TOKEN_REGEX.exec(str)) !== null) {
      if (m.index > last) ed.appendChild(document.createTextNode(str.slice(last, m.index)));
      ed.appendChild(buildChip(m[1]));
      last = m.index + m[0].length;
    }
    if (last < str.length) ed.appendChild(document.createTextNode(str.slice(last)));
    // Ensure there's always a trailing text node so caret can land at end.
    if (!ed.lastChild || (ed.lastChild as Element).nodeType !== Node.TEXT_NODE) {
      ed.appendChild(document.createTextNode(""));
    }
  };

  const serialize = (): string => {
    const ed = editorRef.current;
    if (!ed) return "";
    let out = "";
    ed.childNodes.forEach((n) => {
      if (n.nodeType === Node.TEXT_NODE) {
        out += n.textContent ?? "";
      } else if (n.nodeType === Node.ELEMENT_NODE) {
        const el = n as HTMLElement;
        const path = el.getAttribute("data-token");
        if (path) out += `{{${path}}}`;
        else if (el.tagName === "BR") out += "\n";
        else out += el.textContent ?? "";
      }
    });
    return out;
  };

  // Sync external value → DOM only when it diverges (e.g. parent reset).
  useEffect(() => {
    if (value !== lastSerialized.current) {
      lastSerialized.current = value;
      renderToDom(value);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, registered]);

  const handleInput = () => {
    const next = serialize();
    lastSerialized.current = next;
    onChange(next);
  };

  // ── Token picker insert at caret ────────────────────────────────
  const insertChipAtCaret = (path: string) => {
    const ed = editorRef.current;
    if (!ed) return;
    ed.focus();
    const sel = window.getSelection();
    let range: Range;
    if (sel && sel.rangeCount > 0 && ed.contains(sel.anchorNode)) {
      range = sel.getRangeAt(0);
      range.deleteContents();
    } else {
      range = document.createRange();
      range.selectNodeContents(ed);
      range.collapse(false);
    }
    const chip = buildChip(path);
    const space = document.createTextNode("\u00A0");
    range.insertNode(space);
    range.insertNode(chip);
    // Move caret after the trailing space.
    const after = document.createRange();
    after.setStartAfter(space);
    after.collapse(true);
    sel?.removeAllRanges();
    sel?.addRange(after);
    setOpen(false);
    handleInput();
  };

  // ── Diagnostic chips (malformed only — token registry status is on the inline chips) ──
  const malformed = useMemo(() => {
    const seen = new Set<string>();
    const out: string[] = [];
    const matches = value.match(MALFORMED_REGEX) ?? [];
    for (const m of matches) {
      // A malformed brace-pair is one that doesn't match the strict token shape.
      const strict = /^\{\{\s*[a-zA-Z0-9_.]+\s*\}\}$/.test(m);
      if (!strict && !seen.has(m)) {
        seen.add(m);
        out.push(m);
      }
    }
    return out;
  }, [value]);

  // ── Token picker (groups by source) ──────────────────────────────
  const grouped = useMemo(() => {
    const out: Record<string, typeof registry> = {};
    const q = filter.trim().toLowerCase();
    for (const t of registry ?? []) {
      if (q && !t.token_path.toLowerCase().includes(q) && !(t.description ?? "").toLowerCase().includes(q)) continue;
      const key = t.source ?? "other";
      (out[key] ??= [] as any).push(t);
    }
    return out;
  }, [registry, filter]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <span className="text-[11px] text-muted-foreground inline-flex items-center gap-1">
          <Variable className="h-3 w-3" />
          Type plain text. Use <strong>Insert field</strong> to add dynamic values.
        </span>
        <Popover open={open} onOpenChange={setOpen}>
          <PopoverTrigger asChild>
            <Button type="button" size="sm" variant="outline" className="h-7">
              <Plus className="h-3.5 w-3.5 mr-1" />Insert field
            </Button>
          </PopoverTrigger>
          <PopoverContent className="w-[360px] p-0" align="end">
            <div className="p-2 border-b flex items-center gap-2">
              <Search className="h-3.5 w-3.5 text-muted-foreground" />
              <Input
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                placeholder="Search fields…"
                className="h-7 text-xs"
              />
            </div>
            <ScrollArea className="h-[280px]">
              <div className="p-2 space-y-3">
                {Object.keys(grouped).length === 0 && (
                  <div className="text-xs text-muted-foreground px-2 py-4 text-center">No fields match.</div>
                )}
                {Object.entries(grouped).map(([source, list]) => (
                  <div key={source}>
                    <div className="text-[10px] uppercase tracking-wide text-muted-foreground mb-1 px-1">
                      {source}
                    </div>
                    <div className="space-y-0.5">
                      {(list ?? []).map((t) => (
                        <button
                          key={t.id}
                          type="button"
                          className="w-full text-left px-2 py-1.5 rounded hover:bg-accent text-xs flex flex-col"
                          onClick={() => insertChipAtCaret(t.token_path)}
                        >
                          <span className="font-medium">{humanizeToken(t.token_path, t.description ?? null)}</span>
                          {t.description && (
                            <span className="text-muted-foreground text-[10px] truncate">{t.token_path}</span>
                          )}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            </ScrollArea>
          </PopoverContent>
        </Popover>
      </div>

      <div
        id={id}
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        onInput={handleInput}
        onBlur={handleInput}
        role="textbox"
        aria-multiline="true"
        data-placeholder={placeholder}
        style={{ minHeight: `${rows * 1.5}rem` }}
        className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm leading-relaxed whitespace-pre-wrap focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-0"
      />

      <div className="flex flex-wrap items-center gap-2 text-[10px] text-muted-foreground">
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-primary" /> Registered field
        </span>
        <span className="inline-flex items-center gap-1">
          <span className="inline-block h-2 w-2 rounded-full bg-amber-500" /> Unknown field — likely typo
        </span>
        {malformed.length > 0 && (
          <div className="flex flex-wrap gap-1 ml-2">
            {malformed.map((m, i) => (
              <Badge
                key={`${m}-${i}`}
                variant="outline"
                className="border-destructive/60 text-destructive text-[10px]"
                title={`Malformed field placeholder: ${m}`}
              >
                Incomplete field placeholder
              </Badge>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

// Kept for back-compat with tests that import these names.
export type TokenStatus = "registered" | "unknown" | "malformed";
export interface ClassifiedToken {
  raw: string;
  path: string | null;
  status: TokenStatus;
}
export function classifyTokens(body: string, registered: Set<string>): ClassifiedToken[] {
  const matches = body.match(/\{\{[^}]*\}?\}?/g) ?? [];
  return matches.map((raw) => {
    const strict = /^\{\{\s*[a-zA-Z0-9_.]+\s*\}\}$/.test(raw);
    if (!strict) return { raw, path: null, status: "malformed" as const };
    const path = raw.replace(/^\{\{\s*/, "").replace(/\s*\}\}$/, "");
    return { raw, path, status: registered.has(path) ? ("registered" as const) : ("unknown" as const) };
  });
}
