import { truncateTip } from '@/lib/render/text';

/** Hover tooltip. The text is repo-derived, so it renders only as a React text node, cut to 200 characters. */
export function Tooltip({ text, x, y }: { text: string; x: number; y: number }) {
  return (
    <div
      role="tooltip"
      style={{
        position: 'absolute',
        left: x + 14,
        top: y + 14,
        maxWidth: 360,
        padding: '6px 10px',
        background: 'var(--surface)',
        color: 'var(--text)',
        border: '1px solid var(--border)',
        borderRadius: 6,
        font: '12px/1.4 var(--font-mono, ui-monospace, monospace)',
        overflowWrap: 'anywhere',
        pointerEvents: 'none',
        zIndex: 2,
      }}
    >
      {truncateTip(text)}
    </div>
  );
}
