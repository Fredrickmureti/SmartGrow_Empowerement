/**
 * CodeField — monospaced field for machine values (bind keys, tokens,
 * expressions, format strings). Thin wrapper over AutoGrowInput /
 * AutoGrowTextarea that also carries a small "code" affordance so
 * publishers know they're editing a machine-readable value.
 */
import { AutoGrowInput } from "./AutoGrowInput";
import { AutoGrowTextarea } from "./AutoGrowTextarea";

interface Props {
  value: string;
  onChange: (next: string) => void;
  placeholder?: string;
  /** Force multiline mode. Default: single-line unless value contains \n. */
  multiline?: boolean;
  className?: string;
  disabled?: boolean;
}

export function CodeField({ value, onChange, placeholder, multiline, className, disabled }: Props) {
  const wantMultiline = multiline || value.includes("\n");
  if (wantMultiline) {
    return (
      <AutoGrowTextarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        monospace
        minRows={2}
        className={className}
        disabled={disabled}
      />
    );
  }
  return (
    <AutoGrowInput
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      monospace
      className={className}
      disabled={disabled}
    />
  );
}
