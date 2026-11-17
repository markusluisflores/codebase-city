import { notFound } from 'next/navigation';
import { FramesClient } from './FramesClient';

export const metadata = { title: 'Frame-time check (dev only)' };

/** Dev-only page for the by-hand frame-time measurement. It does not exist in a production build. */
export default function FramesPage() {
  if (process.env.NODE_ENV === 'production') notFound();
  return <FramesClient />;
}
