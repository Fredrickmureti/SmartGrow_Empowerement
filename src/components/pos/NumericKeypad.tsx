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
    <div className="grid grid-cols-3 gap-3">
      {buttons.flat().map((key) => (
        <Button
          key={key}
          variant="outline"
          className="h-20 sm:h-24 text-3xl sm:text-4xl font-semibold rounded-xl shadow-sm active:scale-95 transition-transform"
          onClick={() => {
            if (key === "⌫") {
              onBackspace();
            } else {
              handleKeyPress(key);
            }
          }}
        >
          {key === "⌫" ? <Delete className="h-7 w-7" /> : key}
        </Button>
      ))}
      <Button
        variant="destructive"
        className="col-span-3 h-16 text-lg font-semibold rounded-xl"
        onClick={onClear}
      >
        <X className="h-5 w-5 mr-2" />
        Clear
      </Button>
    </div>
  );
}
