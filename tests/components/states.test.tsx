// @vitest-environment jsdom
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { EmptyGallery } from '@/components/EmptyGallery';
import { ErrorState } from '@/components/ErrorState';
import { LoadingSkeleton } from '@/components/LoadingSkeleton';
import { ThinHistoryNote } from '@/components/ThinHistoryNote';
import { Tooltip } from '@/components/Tooltip';
import { ViewerLoader } from '@/components/ViewerLoader';
import { ERROR_CODES, errorMessage } from '@/lib/errors';
import { viewerAnalysis } from '../helpers/viewerFixture';

vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));
vi.mock('@/components/Viewer', () => ({ Viewer: () => <div data-testid="viewer" /> }));

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('ErrorState', () => {
  it.each(ERROR_CODES)('renders the message for %s, and no stack trace', (code) => {
    render(<ErrorState code={code} />);
    const alert = screen.getByRole('alert');
    expect(alert.textContent).toContain(errorMessage(code));
    expect(alert.textContent).not.toMatch(/\bat .*\(|stack|node_modules|\.tsx?:\d+/i);
  });

  it('gives every code its own message, except the documented shared pair', () => {
    const shared = new Set(['invalid_body', 'unsupported_media_type']);
    const messages = ERROR_CODES.filter((c) => !shared.has(c)).map(errorMessage);
    expect(new Set(messages).size).toBe(messages.length);
  });

  it('falls back to the internal_error message for an unknown code, never echoing it', () => {
    render(<ErrorState code="<b>weird</b>" />);
    expect(screen.getByRole('alert').textContent).toBe(errorMessage('internal_error'));
  });

  it('knows the two client-side codes', () => {
    render(<ErrorState code="network" />);
    expect(screen.getByRole('alert').textContent).toMatch(/reach the server/i);
    cleanup();
    render(<ErrorState code="unreadable" />);
    expect(screen.getByRole('alert').textContent).toMatch(/couldn't be read/i);
  });

  it('shows a retry button only when given a handler, and calls it', async () => {
    const retry = vi.fn();
    const { rerender } = render(<ErrorState code="clone_failed" />);
    expect(screen.queryByRole('button')).toBeNull();
    rerender(<ErrorState code="clone_failed" onRetry={retry} />);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    expect(retry).toHaveBeenCalledTimes(1);
  });
});

describe('ThinHistoryNote', () => {
  it('names the commit count and only shows when thin', () => {
    const { rerender } = render(<ThinHistoryNote thin mode="hotspot" commits={7} />);
    expect(screen.getByText(/only 7 commits/i)).toBeTruthy();
    rerender(<ThinHistoryNote thin={false} mode="hotspot" commits={7} />);
    expect(screen.queryByText(/thin history/i)).toBeNull();
    rerender(<ThinHistoryNote thin mode="hotspot" commits={1} />);
    expect(screen.getByText(/only 1 commit /i)).toBeTruthy();
  });
});

describe('loading, empty and retry states', () => {
  it('renders a loading skeleton while the Analysis fetches', () => {
    vi.stubGlobal('fetch', () => new Promise(() => undefined));
    render(<ViewerLoader owner="octo" repo="repo" />);
    expect(screen.getByRole('status').getAttribute('aria-busy')).toBe('true');
    expect(screen.getByText(/loading the analysis/i)).toBeTruthy();
  });

  it('the skeleton has a main region to focus', () => {
    render(<LoadingSkeleton />);
    expect(screen.getByRole('main')).toBeTruthy();
  });

  it('a fetch failure shows the error with a retry button that refetches', async () => {
    const fetchMock = vi
      .fn<(url: string) => Promise<Response>>()
      .mockRejectedValueOnce(new Error('offline'))
      .mockResolvedValueOnce(
        Response.json({ source: 'live', analysedAt: null, analysis: viewerAnalysis() }),
      );
    vi.stubGlobal('fetch', fetchMock);
    render(<ViewerLoader owner="octo" repo="repo" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toMatch(/reach the server/i);
    await userEvent.click(screen.getByRole('button', { name: /try again/i }));
    await waitFor(() => expect(screen.getByTestId('viewer')).toBeTruthy());
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('a server error code shows its own message', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(Response.json({ error: 'db_unavailable', message: 'raw' }, { status: 503 })),
    );
    render(<ViewerLoader owner="octo" repo="repo" />);
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('alert').textContent).toContain(errorMessage('db_unavailable'));
    expect(screen.getByRole('alert').textContent).not.toContain('raw');
  });

  it('an empty gallery renders the empty state', () => {
    render(<EmptyGallery />);
    expect(screen.getByText(/no repos in the gallery yet/i)).toBeTruthy();
  });
});

describe('hostile strings', () => {
  it('a tooltip with a 300-character path is cut to 200 characters, as text', () => {
    const evil = `<img src=x onerror=alert(1)>${'a'.repeat(300)}`;
    const { container } = render(<Tooltip text={evil} x={0} y={0} />);
    expect(container.querySelector('img')).toBeNull();
    const text = screen.getByRole('tooltip').textContent ?? '';
    expect(text.length).toBeLessThanOrEqual(200);
    expect(text.startsWith('<img src=x onerror=alert(1)>')).toBe(true);
  });
});
