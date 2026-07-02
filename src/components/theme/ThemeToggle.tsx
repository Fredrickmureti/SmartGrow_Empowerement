import { Moon, Sun, Monitor } from "lucide-react";
import { useTheme } from "next-themes";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";

interface ThemeToggleProps {
  collapsed?: boolean;
}

export function ThemeToggle({ collapsed = false }: ThemeToggleProps) {
  const { theme, setTheme } = useTheme();

  const toggleButton = (
    <Button
      variant="ghost"
      size={collapsed ? "icon" : "default"}
      className={cn(
        collapsed ? "justify-center h-10 w-10" : "justify-start gap-3 px-3",
      )}
    >
      <Sun className="h-4 w-4 rotate-0 scale-100 transition-all dark:-rotate-90 dark:scale-0" />
      <Moon className="absolute h-4 w-4 rotate-90 scale-0 transition-all dark:rotate-0 dark:scale-100" />
      {!collapsed && <span>Theme</span>}
      <span className="sr-only">Toggle theme</span>
    </Button>
  );

  return (
    <DropdownMenu>
      {collapsed ? (
        <Tooltip delayDuration={0}>
          <TooltipTrigger asChild>
            <DropdownMenuTrigger asChild>{toggleButton}</DropdownMenuTrigger>
          </TooltipTrigger>
          {/* Only render tooltip content in collapsed mode to avoid duplicate “Theme” labels */}
          <TooltipContent side="right">Theme</TooltipContent>
        </Tooltip>
      ) : (
        <DropdownMenuTrigger asChild>{toggleButton}</DropdownMenuTrigger>
      )}

      <DropdownMenuContent align={collapsed ? "center" : "start"} side="top">
        <DropdownMenuItem
          onClick={() => setTheme("light")}
          className={cn(theme === "light" && "bg-accent")}
        >
          <Sun className="mr-2 h-4 w-4" />
          Light
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("dark")}
          className={cn(theme === "dark" && "bg-accent")}
        >
          <Moon className="mr-2 h-4 w-4" />
          Dark
        </DropdownMenuItem>
        <DropdownMenuItem
          onClick={() => setTheme("system")}
          className={cn(theme === "system" && "bg-accent")}
        >
          <Monitor className="mr-2 h-4 w-4" />
          System
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
