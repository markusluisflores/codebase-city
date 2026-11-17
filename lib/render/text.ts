/** Longest tooltip, in UTF-16 code units. Repo-derived text is cut to this before it is shown. */
export const MAX_TIP = 200;

/**
 * Cuts text to at most `max` characters, ending in an ellipsis when it was cut and never splitting
 * a surrogate pair. The result is for rendering as plain text only.
 */
export function truncateTip(text: string, max = MAX_TIP): string {
  if (text.length <= max) return text;
  let end = max - 1;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end -= 1; // do not leave half a pair
  return `${text.slice(0, end)}…`;
}
