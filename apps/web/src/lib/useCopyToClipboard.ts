import { useCallback, useEffect, useRef, useState } from "react";

/** Copy text to the clipboard and flash a `copied` flag for `resetMs` (default 1.5s). */
export function useCopyToClipboard(resetMs = 1500) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (timer.current) clearTimeout(timer.current); }, []);
  const copy = useCallback((text: string) => {
    if (!navigator.clipboard) return;
    if (timer.current) clearTimeout(timer.current);
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      timer.current = setTimeout(() => setCopied(false), resetMs);
    }).catch(() => {});
  }, [resetMs]);
  return { copied, copy };
}
