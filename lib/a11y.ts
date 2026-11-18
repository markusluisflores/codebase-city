/** WCAG relative luminance of a `#rgb` or `#rrggbb` colour, 0 (black) to 1 (white). Throws on anything else. */
export function relativeLuminance(hex: string): number {
  const m = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(hex);
  if (!m) throw new Error('relativeLuminance expects #rgb or #rrggbb');
  let h = m[1]!;
  if (h.length === 3) h = [...h].map((c) => c + c).join('');
  const lin = [0, 2, 4].map((i) => {
    const c = parseInt(h.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * lin[0]! + 0.7152 * lin[1]! + 0.0722 * lin[2]!;
}

/** Camera moves: an instant jump when the visitor prefers reduced motion, an animated fly otherwise. */
export function flyToMode(prefersReducedMotion: boolean): 'animate' | 'jump' {
  return prefersReducedMotion ? 'jump' : 'animate';
}

/** Whether a WebGL context can be created here. False on the server and when the browser blocks it. */
export function canUseWebGL(): boolean {
  if (typeof document === 'undefined') return false;
  try {
    const canvas = document.createElement('canvas');
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'));
  } catch {
    return false;
  }
}

/** Whether the visitor asked the OS for reduced motion. False where `matchMedia` is missing. */
export function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.matchMedia === 'function' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  );
}
