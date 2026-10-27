/**
 * Whether this page can run DJ mix's decks (the engine's AudioWorklet).
 * Browsers only give AudioWorklet to a secure page: https, or the computer's
 * own address (localhost, 127.0.0.1). SYNCHRO.S opened over plain http on
 * another machine's address (http://192.168.1.10:8008, say) can't mix: Auto
 * mix says so, and its pairs play on (never a crossfade).
 */
export function mixSupport(
  win: { isSecureContext?: boolean; AudioWorkletNode?: unknown } | null = typeof window === 'object'
    ? (window as unknown as { isSecureContext?: boolean; AudioWorkletNode?: unknown })
    : null,
): string | null {
  if (!win) return null;
  if (win.isSecureContext === false)
    return 'Auto mix needs SYNCHRO.S on https, or opened on its own computer: browsers only run the decks on a secure page';
  if (typeof win.AudioWorkletNode === 'undefined') return "This browser can't run Auto mix's decks";
  return null;
}
