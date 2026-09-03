import { useTheme } from "next-themes";
import { Moon, Sun, Monitor } from "lucide-react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";

export function ThemeSettings() {
  const { theme, setTheme } = useTheme();

  return (
    <Card>
      <CardHeader>
        <CardTitle>Appearance</CardTitle>
        <CardDescription>
          Customize how Smart Grow Empowerment looks on your device
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="space-y-4">
          <Label className="text-base font-medium">Theme</Label>
          <RadioGroup
            value={theme}
            onValueChange={setTheme}
            className="grid grid-cols-1 sm:grid-cols-3 gap-4"
          >
            <Label
              htmlFor="theme-light"
              className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground cursor-pointer [&:has([data-state=checked])]:border-primary"
            >
              <RadioGroupItem value="light" id="theme-light" className="sr-only" />
              <Sun className="mb-3 h-6 w-6" />
              <span className="font-medium">Light</span>
              <span className="text-xs text-muted-foreground text-center mt-1">
                A clean, bright appearance
              </span>
            </Label>
            
            <Label
              htmlFor="theme-dark"
              className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground cursor-pointer [&:has([data-state=checked])]:border-primary"
            >
              <RadioGroupItem value="dark" id="theme-dark" className="sr-only" />
              <Moon className="mb-3 h-6 w-6" />
              <span className="font-medium">Dark</span>
              <span className="text-xs text-muted-foreground text-center mt-1">
                Easy on the eyes at night
              </span>
            </Label>
            
            <Label
              htmlFor="theme-system"
              className="flex flex-col items-center justify-between rounded-md border-2 border-muted bg-popover p-4 hover:bg-accent hover:text-accent-foreground cursor-pointer [&:has([data-state=checked])]:border-primary"
            >
              <RadioGroupItem value="system" id="theme-system" className="sr-only" />
              <Monitor className="mb-3 h-6 w-6" />
              <span className="font-medium">System</span>
              <span className="text-xs text-muted-foreground text-center mt-1">
                Follows your device settings
              </span>
            </Label>
          </RadioGroup>
        </div>
      </CardContent>
    </Card>
  );
}
