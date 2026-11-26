// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ReanalyseStrip } from '@/components/ReanalyseStrip';
import { errorMessage } from '@/lib/errors';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const JOB = '11111111-1111-4111-8111-111111111111';
type Call = { url: string; method: string; body?: string };
const calls: Call[] = [];
let unlocked: boolean;
let analyze: () => Response;
let jobPhases: string[];
let jobIndex: number;

const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  calls.length = 0;
  unlocked = true;
  jobPhases = ['queued', 'cloning', 'reading_history', 'computing', 'done'];
  jobIndex = 0;
  analyze = () => json({ status: 'job', id: JOB });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined });
    if (url === '/api/session' && method === 'GET') {
      return Promise.resolve(
        json(
          unlocked
            ? { unlocked: true, expiresAt: '2026-12-02T09:00:00.000Z' }
            : { unlocked: false },
        ),
      );
    }
    if (url === '/api/session' && method === 'POST') {
      unlocked = true;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url === '/api/analyze') return Promise.resolve(analyze());
    if (url === `/api/jobs/${JOB}`) {
      const phase = jobPhases[Math.min(jobIndex++, jobPhases.length - 1)];
      return Promise.resolve(json({ phase, errorCode: null, message: null }));
    }
    return Promise.resolve(json({}));
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

function strip(over: Partial<React.ComponentProps<typeof ReanalyseStrip>> = {}) {
  const onDone = vi.fn();
  render(
    <ReanalyseStrip
      repo="octo/repo"
      source="live"
      analysedAt="2026-11-03T10:00:00.000Z"
      headSha="a1b2c3d4e5f6"
      onDone={onDone}
      {...over}
    />,
  );
  return { onDone };
}
const openDisclosure = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Check for new commits' }));
  await flush();
};
const confirm = async () => {
  fireEvent.click(screen.getByRole('button', { name: 'Check and re-analyse' }));
  await flush();
};

describe('ReanalyseStrip: who sees it', () => {
  it('shows nothing for a gallery analysis, even when unlocked', async () => {
    strip({ source: 'gallery' });
    await flush();
    expect(screen.queryByRole('button', { name: /check for new commits/i })).toBeNull();
  });

  it('shows nothing to a locked visitor', async () => {
    unlocked = false;
    strip();
    await flush();
    expect(screen.queryByRole('button', { name: /check for new commits/i })).toBeNull();
  });

  it('shows the button to an unlocked visitor on a live analysis', async () => {
    strip();
    await flush();
    expect(screen.getByRole('button', { name: 'Check for new commits' })).toBeTruthy();
  });
});

describe('ReanalyseStrip: the cost note and the check', () => {
  it('explains the cost before anything runs, and Cancel returns focus to the button', async () => {
    strip();
    await flush();
    await openDisclosure();
    const note = screen.getByText(/new analysis/i).textContent ?? '';
    expect(note).toMatch(/new commits/i);
    expect(note).toMatch(/shared daily and monthly limit/i);
    expect(note).toMatch(/4 minutes/i);
    expect(note).toMatch(/costs nothing/i);
    expect(calls.some((c) => c.url === '/api/analyze')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    await flush();
    expect(document.activeElement).toBe(
      screen.getByRole('button', { name: 'Check for new commits' }),
    );
    expect(screen.queryByRole('button', { name: 'Check and re-analyse' })).toBeNull();
  });

  it('says "Up to date" and does not reload when the server answers cached', async () => {
    analyze = () =>
      json({
        status: 'cached',
        source: 'live',
        owner: 'octo',
        name: 'repo',
        headSha: 'a1b2c3d4e5f6',
        analysedAt: '2026-11-03T10:00:00.000Z',
      });
    const { onDone } = strip();
    await flush();
    await openDisclosure();
    await confirm();
    expect(JSON.parse(calls.find((c) => c.url === '/api/analyze')!.body!)).toEqual({
      repo: 'octo/repo',
    });
    expect(screen.getByRole('status').textContent).toMatch(/up to date/i);
    expect(screen.getByRole('status').textContent).toMatch(/a1b2c3d/);
    expect(onDone).not.toHaveBeenCalled();
    expect(push).not.toHaveBeenCalled();
  });

  it('shows the phases while the job runs, disables the button, then reloads once', async () => {
    const { onDone } = strip();
    await flush();
    await openDisclosure();
    await confirm();
    expect(screen.getByRole('list', { name: /analysis progress/i })).toBeTruthy();
    expect(screen.getByRole('button', { name: /check for new commits|checking/i })).toHaveProperty(
      'disabled',
      true,
    );
    await advance(2000);
    await advance(2000);
    await advance(2000);
    await advance(2000);
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });

  it('shows how many analyses are left when the server says so', async () => {
    analyze = () => json({ status: 'job', id: JOB, analysesLeft: 2 });
    strip();
    await flush();
    await openDisclosure();
    await confirm();
    expect(screen.getByText(/2 analyses left today/i)).toBeTruthy();
  });

  it('shows a refusal with its own message and a retry', async () => {
    analyze = () => json({ error: 'analysis_limit', message: 'x' }, 429);
    strip();
    await flush();
    await openDisclosure();
    await confirm();
    expect(screen.getByRole('alert').textContent).toContain(errorMessage('analysis_limit'));
    expect(screen.getByRole('button', { name: /try again/i })).toBeTruthy();
  });

  it('asks for the password again when the session ended, then carries on', async () => {
    let first = true;
    analyze = () => {
      if (first) {
        first = false;
        unlocked = false;
        return json({ error: 'unauthorized', message: 'x' }, 401);
      }
      return json({ status: 'job', id: JOB });
    };
    strip();
    await flush();
    await openDisclosure();
    await confirm();
    const field = screen.getByLabelText(/demo password/i);
    fireEvent.change(field, { target: { value: 'hunter2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
    await flush();
    expect(calls.filter((c) => c.url === '/api/analyze')).toHaveLength(2);
    expect(screen.getByRole('list', { name: /analysis progress/i })).toBeTruthy();
  });
});
