import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { cn } from "@/lib/utils";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

interface MarkdownRendererProps {
  content: string;
  className?: string;
}

export function MarkdownRenderer({ content, className }: MarkdownRendererProps) {
  return (
    <div className={cn("prose prose-sm max-w-none dark:prose-invert", className)}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => (
            <h1 className="text-xl font-semibold text-foreground mt-4 mb-2">{children}</h1>
          ),
          h2: ({ children }) => (
            <h2 className="text-lg font-semibold text-foreground mt-3 mb-2">{children}</h2>
          ),
          h3: ({ children }) => (
            <h3 className="text-base font-semibold text-foreground mt-2 mb-1">{children}</h3>
          ),
          p: ({ children }) => (
            <p className="text-muted-foreground leading-relaxed my-2">{children}</p>
          ),
          ul: ({ children }) => (
            <ul className="list-disc pl-4 my-2 space-y-1">{children}</ul>
          ),
          ol: ({ children }) => (
            <ol className="list-decimal pl-4 my-2 space-y-1">{children}</ol>
          ),
          li: ({ children }) => (
            <li className="text-muted-foreground">{children}</li>
          ),
          strong: ({ children }) => (
            <strong className="text-foreground font-semibold">{children}</strong>
          ),
          code: ({ children }) => (
            <code className="bg-muted text-foreground px-1.5 py-0.5 rounded text-xs">
              {children}
            </code>
          ),
          pre: ({ children }) => (
            <pre className="bg-muted text-foreground p-3 rounded-lg overflow-x-auto text-xs my-2">
              {children}
            </pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-primary pl-4 italic text-muted-foreground my-2">
              {children}
            </blockquote>
          ),
          a: ({ href, children }) => (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="text-primary underline underline-offset-2 hover:text-primary/80"
            >
              {children}
            </a>
          ),
          table: ({ children }) => (
            <div className="my-3 rounded-lg border border-border overflow-hidden overflow-x-auto">
              <Table className="min-w-full">
                {children}
              </Table>
            </div>
          ),
          thead: ({ children }) => (
            <TableHeader className="bg-muted">
              {children}
            </TableHeader>
          ),
          tbody: ({ children }) => (
            <TableBody className="bg-background">
              {children}
            </TableBody>
          ),
          tr: ({ children }) => (
            <TableRow className="border-border hover:bg-muted/50">
              {children}
            </TableRow>
          ),
          th: ({ children }) => (
            <TableHead className="font-semibold text-foreground text-xs py-2 px-3 whitespace-nowrap">
              {children}
            </TableHead>
          ),
          td: ({ children }) => (
            <TableCell className="text-foreground text-xs py-2 px-3">
              {children}
            </TableCell>
          ),
        }}
      >
        {content}
      </ReactMarkdown>
    </div>
  );
}
