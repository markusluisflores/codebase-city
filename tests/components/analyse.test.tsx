// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyseForm } from '@/components/AnalyseForm';
import { errorMessage } from '@/lib/errors';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

type Handler = (url: string, init?: RequestInit) => Response | Promise<Response>;
let handler: Handler;
const calls: { url: string; init?: RequestInit }[] = [];

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  calls.length = 0;
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    calls.push({ url, init });
    return Promise.resolve(handler(url, init));
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const json = (body: unknown, status = 200) => Response.json(body, { status });
const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const advance = (ms: number) => act(async () => void (await vi.advanceTimersByTimeAsync(ms)));

async function submit(repo = 'octo/repo') {
  fireEvent.change(screen.getByLabelText(/github repository/i), { target: { value: repo } });
  fireEvent.click(screen.getByRole('button', { name: 'Analyse' }));
  await flush();
}

describe('AnalyseForm', () => {
  it('rejects a bad repo input without calling the API', async () => {
    handler = () => json({});
    render(<AnalyseForm />);
    await submit('not a repo');
    expect(screen.getByRole('alert').textContent).toContain(errorMessage('invalid_repo'));
    expect(calls).toHaveLength(0);
  });

  it('opens the viewer straight away on a cached answer', async () => {
    handler = () => json({ status: 'cached', source: 'gallery', owner: 'Octo', name: 'Repo' });
    render(<AnalyseForm />);
    await submit('https://github.com/Octo/Repo');
    expect(push).toHaveBeenCalledWith('/r/octo/repo');
    expect(calls[0]!.url).toBe('/api/analyze');
    expect(calls[0]!.init?.method).toBe('POST');
    expect(JSON.parse(String(calls[0]!.init?.body))).toEqual({ repo: 'Octo/Repo' });
  });

  it('shows each phase in order while polling, then opens the viewer', async () => {
    const phases = ['queued', 'cloning', 'reading_history', 'computing', 'done'];
    let n = 0;
    handler = (url) =>
      url === '/api/analyze'
        ? json({ status: 'job', id: '11111111-1111-4111-8111-111111111111' })
        : json({ phase: phases[Math.min(n++, phases.length - 1)], errorCode: null, message: null });
    render(<AnalyseForm />);
    await submit();
    const current = () => screen.getByRole('listitem', { current: 'step' }).textContent;
    const seen: string[] = [current()!];
    for (let i = 0; i < 3; i++) {
      await advance(2000);
      seen.push(current()!);
    }
    expect(seen).toEqual([
      'Waiting for a free slot',
      'Fetching the repository history',
      'Reading the commit history',
      'Working out hotspots and the layout',
    ]);
    expect(screen.getByRole('status').textContent).toMatch(/step 4 of 4/i);
    await advance(2000);
    expect(push).toHaveBeenCalledWith('/r/octo/repo');
  });

  it('disables the form while busy', async () => {
    handler = (url) =>
      url === '/api/analyze'
        ? json({ status: 'job', id: '11111111-1111-4111-8111-111111111111' })
        : json({ phase: 'queued' });
    render(<AnalyseForm />);
    await submit();
    expect((screen.getByLabelText(/github repository/i) as HTMLInputElement).disabled).toBe(true);
    expect((screen.getByRole('button', { name: 'Analyse' }) as HTMLButtonElement).disabled).toBe(
      true,
    );
  });

  it('stops polling on unmount and never stacks timers', async () => {
    handler = (url) =>
      url === '/api/analyze'
        ? json({ status: 'job', id: '11111111-1111-4111-8111-111111111111' })
        : json({ phase: 'cloning' });
    const { unmount } = render(<AnalyseForm />);
    await submit();
    await advance(6000);
    const polls = () => calls.filter((c) => c.url.startsWith('/api/jobs/')).length;
    expect(polls()).toBe(4); // t = 0, 2, 4, 6 s: one timer, not several
    unmount();
    await advance(20_000);
    expect(polls()).toBe(4);
  });

  it('shows a failed job with its own message', async () => {
    handler = (url) =>
      url === '/api/analyze'
        ? json({ status: 'job', id: '11111111-1111-4111-8111-111111111111' })
        : json({ phase: 'failed', errorCode: 'clone_failed', message: 'x' });
    render(<AnalyseForm />);
    await submit();
    expect(screen.getByRole('alert').textContent).toContain(errorMessage('clone_failed'));
    expect(push).not.toHaveBeenCalled();
  });

  it('shows the API error code of a refused request', async () => {
    handler = () => json({ error: 'repo_too_large', message: 'x' }, 422);
    render(<AnalyseForm />);
    await submit();
    expect(screen.getByRole('alert').textContent).toContain(errorMessage('repo_too_large'));
  });

  it('gives up with a network message after three polls with no reply', async () => {
    let polling = false;
    vi.stubGlobal('fetch', (url: string) => {
      if (url === '/api/analyze') {
        polling = true;
        return Promise.resolve(json({ status: 'job', id: '11111111-1111-4111-8111-111111111111' }));
      }
      return polling ? Promise.reject(new Error('offline')) : Promise.resolve(json({}));
    });
    render(<AnalyseForm />);
    await submit();
    await advance(6000);
    expect(screen.getByRole('alert').textContent).toMatch(/reach the server/i);
  });

  describe('password flow', () => {
    const unauthorized = () => json({ error: 'unauthorized', message: 'x' }, 401);

    it('asks for the demo password on 401, then signs in and retries', async () => {
      let signedIn = false;
      handler = (url) => {
        if (url === '/api/session') {
          signedIn = true;
          return new Response(null, { status: 204 });
        }
        return signedIn
          ? json({ status: 'cached', source: 'live', owner: 'octo', name: 'repo' })
          : unauthorized();
      };
      render(<AnalyseForm />);
      await submit();
      expect(screen.getByText(/enter the demo password to analyse/i)).toBeTruthy();
      const field = screen.getByLabelText(/demo password/i) as HTMLInputElement;
      expect(field.type).toBe('password');
      fireEvent.change(field, { target: { value: 'hunter2' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await flush();
      const session = calls.find((c) => c.url === '/api/session')!;
      expect(JSON.parse(String(session.init?.body))).toEqual({ password: 'hunter2' });
      expect(push).toHaveBeenCalledWith('/r/octo/repo');
      // Neither the password nor the repo ever appears in a URL.
      for (const c of calls) expect(c.url).not.toMatch(/hunter2|octo|repo/);
    });

    it('shows wrong_password under the field and keeps the prompt', async () => {
      handler = (url) =>
        url === '/api/session' ? json({ error: 'wrong_password' }, 401) : unauthorized();
      render(<AnalyseForm />);
      await submit();
      const field = screen.getByLabelText(/demo password/i) as HTMLInputElement;
      fireEvent.change(field, { target: { value: 'nope' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await flush();
      expect(screen.getByRole('alert').textContent).toBe(errorMessage('wrong_password'));
      expect(screen.getByLabelText(/demo password/i)).toBeTruthy();
      expect((screen.getByLabelText(/demo password/i) as HTMLInputElement).value).toBe('');
    });

    it('shows too_many_attempts on 429', async () => {
      handler = (url) =>
        url === '/api/session' ? json({ error: 'too_many_attempts' }, 429) : unauthorized();
      render(<AnalyseForm />);
      await submit();
      fireEvent.change(screen.getByLabelText(/demo password/i), { target: { value: 'x' } });
      fireEvent.click(screen.getByRole('button', { name: 'Continue' }));
      await flush();
      expect(screen.getByRole('alert').textContent).toBe(errorMessage('too_many_attempts'));
    });
  });

  it('prefills the repo from initialRepo and calls onDone instead of navigating', async () => {
    handler = () => json({ status: 'cached', source: 'live', owner: 'octo', name: 'repo' });
    const onDone = vi.fn();
    render(<AnalyseForm initialRepo="octo/repo" onDone={onDone} />);
    expect((screen.getByLabelText(/github repository/i) as HTMLInputElement).value).toBe(
      'octo/repo',
    );
    fireEvent.click(screen.getByRole('button', { name: 'Analyse' }));
    await flush();
    expect(onDone).toHaveBeenCalledTimes(1);
    expect(push).not.toHaveBeenCalled();
  });
});
