import { Button } from "@/components/ui/button";
import { Delete, X } from "lucide-react";

interface NumericKeypadProps {
  value: string;
  onChange: (value: string) => void;
  onClear: () => void;
  onBackspace: () => void;
  showDecimal?: boolean;
  maxLength?: number;
}

export function NumericKeypad({
  value,
  onChange,
  onClear,
  onBackspace,
  showDecimal = true,
  maxLength = 10,
}: NumericKeypadProps) {
  const handleKeyPress = (key: string) => {
    if (value.length >= maxLength) return;
    
    if (key === "." && value.includes(".")) return;
    if (key === "." && !value) {
      onChange("0.");
      return;
    }
    
    onChange(value + key);
  };

  const buttons = [
    ["7", "8", "9"],
    ["4", "5", "6"],
    ["1", "2", "3"],
    [showDecimal ? "." : "00", "0", "⌫"],
  ];

  return (
    <div className="grid grid-cols-3 gap-2">
      {buttons.flat().map((key) => (
        <Button
          key={key}
          variant="outline"
          className="h-14 text-xl font-medium"
          onClick={() => {
            if (key === "⌫") {
              onBackspace();
            } else {
              handleKeyPress(key);
            }
          }}
        >
          {key === "⌫" ? <Delete className="h-5 w-5" /> : key}
        </Button>
      ))}
      <Button
        variant="destructive"
        className="col-span-3 h-12"
        onClick={onClear}
      >
        <X className="h-4 w-4 mr-2" />
        Clear
      </Button>
    </div>
  );
}
