/**
 * SMS character & segment counter.
 * GSM-7: 160 chars per segment (or 153 for multi-segment).
 * Unicode: 70 chars per segment (or 67 for multi-segment).
 */

// GSM-7 basic character set (simplified check)
const GSM7_REGEX = /^[@£$¥èéùìòÇ\nØø\rÅåΔ_ΦΓΛΩΠΨΣΘΞÆæßÉ !"#¤%&'()*+,\-./0-9:;<=>?¡A-ZÄÖÑܧ¿a-zäöñüà\r\n{}[\]~|€\\^]*$/;

function isGsm7(text: string): boolean {
  return GSM7_REGEX.test(text);
}

interface SmsCharCounterProps {
  text: string;
}

export function SmsCharCounter({ text }: SmsCharCounterProps) {
  if (!text) return null;

  const gsm = isGsm7(text);
  const charCount = text.length;

  let segmentLimit: number;
  let multiSegmentLimit: number;

  if (gsm) {
    segmentLimit = 160;
    multiSegmentLimit = 153;
  } else {
    segmentLimit = 70;
    multiSegmentLimit = 67;
  }

  const segments =
    charCount <= segmentLimit
      ? 1
      : Math.ceil(charCount / multiSegmentLimit);

  const encoding = gsm ? "GSM-7" : "Unicode";
  const isWarning = segments > 3;

  return (
    <div className={`text-xs flex items-center gap-2 ${isWarning ? "text-destructive" : "text-muted-foreground"}`}>
      <span>{charCount} chars</span>
      <span>•</span>
      <span>{segments} segment{segments !== 1 ? "s" : ""}</span>
      <span>•</span>
      <span>{encoding}</span>
    </div>
  );
}
