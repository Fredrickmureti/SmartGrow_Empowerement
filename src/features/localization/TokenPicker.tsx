/**
 * Token picker for template editors. Reads the platform + pack token
 * registry and lets users insert a `{{token.path}}` reference into a
 * text field. Shows source, type, and sample value so authors don't
 * have to memorize identifiers.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { Command, CommandEmpty, CommandGroup, CommandInput, CommandItem, CommandList } from "@/components/ui/command";
import { Badge } from "@/components/ui/badge";
import { Variable } from "lucide-react";
import { useTokenRegistry } from "./hooks";

interface Props {
  pack_id?: string | null;
  onPick: (token: string) => void;
  triggerLabel?: string;
}

export function TokenPicker({ pack_id, onPick, triggerLabel = "Insert token" }: Props) {
  const { data: tokens, isLoading } = useTokenRegistry(pack_id);
  const [open, setOpen] = useState(false);

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button variant="outline" size="sm" type="button"><Variable className="h-3.5 w-3.5 mr-1" />{triggerLabel}</Button>
      </PopoverTrigger>
      <PopoverContent className="w-[420px] p-0" align="start">
        <Command>
          <CommandInput placeholder="Search tokens…" />
          <CommandList>
            <CommandEmpty>{isLoading ? "Loading…" : "No tokens"}</CommandEmpty>
            {Object.entries(
              (tokens ?? []).reduce((acc: Record<string, typeof tokens>, t) => {
                (acc[t.source] ??= [] as any).push(t);
                return acc;
              }, {})
            ).map(([source, list]) => (
              <CommandGroup key={source} heading={source}>
                {(list ?? []).map((t) => (
                  <CommandItem
                    key={t.id}
                    value={t.token_path}
                    onSelect={() => { onPick(`{{${t.token_path}}}`); setOpen(false); }}
                  >
                    <div className="flex flex-col flex-1 min-w-0">
                      <span className="font-mono text-xs">{`{{${t.token_path}}}`}</span>
                      {t.description && <span className="text-xs text-muted-foreground truncate">{t.description}</span>}
                    </div>
                    <Badge variant="secondary" className="ml-2 text-[10px]">{t.data_type}</Badge>
                    {t.deprecated_in_version && <Badge variant="destructive" className="ml-1 text-[10px]">deprecated</Badge>}
                  </CommandItem>
                ))}
              </CommandGroup>
            ))}
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  );
}
