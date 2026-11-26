// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AnalyseGate } from '@/components/AnalyseGate';
import { errorMessage } from '@/lib/errors';

const push = vi.fn();
vi.mock('next/navigation', () => ({ useRouter: () => ({ push }) }));

const EXPIRES = '2026-12-02T09:00:00.000Z';
type Call = { url: string; method: string; body?: string; init?: RequestInit };
const calls: Call[] = [];
let unlocked: boolean;
let loginResponse: () => Response;
let statusFails: boolean;
let analyzeResponse: () => Response;

const json = (body: unknown, status = 200) => Response.json(body, { status });

beforeEach(() => {
  vi.useFakeTimers();
  push.mockClear();
  calls.length = 0;
  unlocked = false;
  statusFails = false;
  loginResponse = () => new Response(null, { status: 204 });
  analyzeResponse = () => json({ status: 'cached', source: 'live', owner: 'octo', name: 'repo' });
  vi.stubGlobal('fetch', (url: string, init?: RequestInit) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? String(init.body) : undefined, init });
    if (url === '/api/session' && method === 'GET') {
      return statusFails
        ? Promise.reject(new Error('offline'))
        : Promise.resolve(
            json(unlocked ? { unlocked: true, expiresAt: EXPIRES } : { unlocked: false }),
          );
    }
    if (url === '/api/session' && method === 'POST') {
      const res = loginResponse();
      if (res.status === 204) unlocked = true;
      return Promise.resolve(res);
    }
    if (url === '/api/session' && method === 'DELETE') {
      unlocked = false;
      return Promise.resolve(new Response(null, { status: 204 }));
    }
    if (url === '/api/analyze') return Promise.resolve(analyzeResponse());
    return Promise.resolve(json({}));
  });
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const flush = () => act(async () => void (await vi.advanceTimersByTimeAsync(0)));
const openPanel = async () => {
  fireEvent.click(screen.getByRole('button', { name: /analyse your own repo/i }));
  await flush();
};
const typePassword = (value: string) =>
  fireEvent.change(screen.getByLabelText(/demo password/i), { target: { value } });

describe('AnalyseGate on the home page', () => {
  it('shows the locked entry, not a repo form, and explains the password', async () => {
    render(<AnalyseGate />);
    await flush();
    const trigger = screen.getByRole('button', { name: /analyse your own repo/i });
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByLabelText(/github repository/i)).toBeNull();
    expect(screen.queryByLabelText(/demo password/i)).toBeNull();
    expect(screen.getByText(/needs a demo password/i)).toBeTruthy();
  });

  it('renders the locked entry straight away, before the status answer arrives', () => {
    render(<AnalyseGate />);
    expect(screen.getByRole('button', { name: /analyse your own repo/i })).toBeTruthy();
  });

  it('asks the status route with no-store, and treats a failed request as locked', async () => {
    statusFails = true;
    render(<AnalyseGate />);
    await flush();
    expect(calls[0]).toMatchObject({ url: '/api/session', method: 'GET' });
    expect((calls[0]!.init as RequestInit).cache).toBe('no-store');
    expect(screen.getByRole('button', { name: /analyse your own repo/i })).toBeTruthy();
  });

  it('opens the panel with focus in the password field; Escape closes it and returns focus', async () => {
    render(<AnalyseGate />);
    await flush();
    await openPanel();
    const trigger = screen.getByRole('button', { name: /analyse your own repo/i });
    expect(trigger.getAttribute('aria-expanded')).toBe('true');
    const field = screen.getByLabelText(/demo password/i) as HTMLInputElement;
    expect(field.type).toBe('password');
    expect(document.activeElement).toBe(field);
    fireEvent.keyDown(field, { key: 'Escape' });
    await flush();
    expect(screen.queryByLabelText(/demo password/i)).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(trigger.getAttribute('aria-expanded')).toBe('false');
  });

  it('shows wrong_password under the field, clears it and puts focus back in it', async () => {
    loginResponse = () => json({ error: 'wrong_password' }, 401);
    render(<AnalyseGate />);
    await flush();
    await openPanel();
    typePassword('nope');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain(errorMessage('wrong_password'));
    const field = screen.getByLabelText(/demo password/i) as HTMLInputElement;
    expect(field.value).toBe('');
    expect(document.activeElement).toBe(field);
  });

  it('shows too_many_attempts on 429', async () => {
    loginResponse = () => json({ error: 'too_many_attempts' }, 429);
    render(<AnalyseGate />);
    await flush();
    await openPanel();
    typePassword('x');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await flush();
    expect(screen.getByRole('alert').textContent).toContain(errorMessage('too_many_attempts'));
  });

  it('unlocks: posts the password in the body only, shows the repo form focused and announces it', async () => {
    render(<AnalyseGate />);
    await flush();
    await openPanel();
    typePassword('hunter2');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock' }));
    await flush();
    const login = calls.find((c) => c.method === 'POST')!;
    expect(JSON.parse(login.body!)).toEqual({ password: 'hunter2' });
    for (const c of calls) expect(c.url).not.toMatch(/hunter2/);
    const repo = screen.getByLabelText(/github repository/i);
    expect(document.activeElement).toBe(repo);
    expect(screen.queryByLabelText(/demo password/i)).toBeNull();
    expect(screen.getByText(/unlocked until/i).textContent).toMatch(/2 Dec/);
    expect(
      screen
        .getAllByRole('status')
        .map((r) => r.textContent)
        .join(' '),
    ).toMatch(/unlocked\./i);
  });

  it('shows the repo form at once when the visitor is already unlocked', async () => {
    unlocked = true;
    render(<AnalyseGate />);
    await flush();
    expect(screen.getByLabelText(/github repository/i)).toBeTruthy();
    expect(screen.queryByRole('button', { name: /analyse your own repo/i })).toBeNull();
    expect(screen.getByRole('button', { name: 'Lock' })).toBeTruthy();
  });

  it('locks: calls DELETE, goes back to the locked entry and focuses it', async () => {
    unlocked = true;
    render(<AnalyseGate />);
    await flush();
    fireEvent.click(screen.getByRole('button', { name: 'Lock' }));
    await flush();
    expect(calls.some((c) => c.method === 'DELETE' && c.url === '/api/session')).toBe(true);
    const trigger = screen.getByRole('button', { name: /analyse your own repo/i });
    expect(document.activeElement).toBe(trigger);
    expect(screen.queryByLabelText(/github repository/i)).toBeNull();
  });
});

describe('AnalyseGate on a not-analysed repo page', () => {
  it('asks only for the password with one "Unlock and analyse" button, then starts the analysis', async () => {
    const onDone = vi.fn();
    render(<AnalyseGate initialRepo="octo/repo" currentRepo="octo/repo" onDone={onDone} />);
    await flush();
    expect(screen.queryByLabelText(/github repository/i)).toBeNull();
    typePassword('hunter2');
    fireEvent.click(screen.getByRole('button', { name: 'Unlock and analyse' }));
    await flush();
    const analyzeCalls = calls.filter((c) => c.url === '/api/analyze');
    expect(analyzeCalls).toHaveLength(1);
    expect(JSON.parse(analyzeCalls[0]!.body!)).toEqual({ repo: 'octo/repo' });
    expect(onDone).toHaveBeenCalledTimes(1);
  });

  it('shows the plain Analyse form (no password) when already unlocked', async () => {
    unlocked = true;
    render(<AnalyseGate initialRepo="octo/repo" currentRepo="octo/repo" onDone={vi.fn()} />);
    await flush();
    expect((screen.getByLabelText(/github repository/i) as HTMLInputElement).value).toBe(
      'octo/repo',
    );
    expect(screen.getByRole('button', { name: 'Analyse' })).toBeTruthy();
    expect(calls.some((c) => c.url === '/api/analyze')).toBe(false);
  });
});
