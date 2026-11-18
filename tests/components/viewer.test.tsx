// @vitest-environment jsdom
import { act, cleanup, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useImperativeHandle } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CityCanvasProps } from '@/components/CityCanvas';
import type { TreemapViewProps } from '@/components/TreemapView';
import { Viewer } from '@/components/Viewer';
import { ViewerLoader } from '@/components/ViewerLoader';
import { viewerAnalysis } from '../helpers/viewerFixture';

const webgl = vi.hoisted(() => ({ ok: true }));
vi.mock('@/lib/a11y', async (orig) => ({
  ...(await orig<typeof import('@/lib/a11y')>()),
  canUseWebGL: () => webgl.ok,
}));
vi.mock('next/navigation', () => ({ useRouter: () => ({ push: vi.fn() }) }));

const flyToPath = vi.fn();
let cityProps: CityCanvasProps | null = null;
let treemapProps: TreemapViewProps | null = null;

vi.mock('@/components/CityCanvas', () => ({
  CityCanvas: (props: CityCanvasProps) => {
    cityProps = props;
    useImperativeHandle(props.ref, () => ({ flyToPath }), []);
    return <div data-testid="city" />;
  },
}));
vi.mock('@/components/TreemapView', () => ({
  TreemapView: (props: TreemapViewProps) => {
    treemapProps = props;
    return <div data-testid="treemap" />;
  },
}));

beforeEach(() => {
  cityProps = null;
  treemapProps = null;
  flyToPath.mockClear();
  webgl.ok = true;
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const analysis = viewerAnalysis();

describe('Viewer', () => {
  it('shows "analysed on <date> at <sha>" for a stored row', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt="2026-11-14T10:00:00.000Z" />);
    expect(screen.getByText(/analysed on 2026-11-14 at bbbbbbb/i)).toBeTruthy();
    expect(screen.getByText('octo/repo')).toBeTruthy();
  });

  it('falls back to the window end for a gallery analysis', () => {
    render(<Viewer analysis={analysis} source="gallery" analysedAt={null} />);
    expect(screen.getByText(/analysed on 2024-03-09 at bbbbbbb/i)).toBeTruthy();
  });

  it('toggles between the 3D city and the 2D treemap', async () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    expect(screen.getByTestId('city')).toBeTruthy();
    expect(screen.queryByTestId('treemap')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '2D' }));
    expect(screen.getByTestId('treemap')).toBeTruthy();
    expect(screen.queryByTestId('city')).toBeNull();
    await userEvent.click(screen.getByRole('button', { name: '3D' }));
    expect(screen.getByTestId('city')).toBeTruthy();
  });

  it('search selects a building and shows its details', async () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    await userEvent.type(screen.getByRole('combobox', { name: /search files/i }), 'readme');
    await userEvent.click(screen.getByRole('option', { name: /docs\/readme\.md/ }));
    expect(cityProps?.selectedPath).toBe('docs/readme.md');
    expect(flyToPath).toHaveBeenCalledWith('docs/readme.md');
    expect(screen.getByRole('complementary', { name: /file details/i }).textContent).toContain(
      'docs/readme.md',
    );
  });

  it('a report-card click flies the camera to that file', async () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    const card = screen.getByRole('complementary', { name: /report card/i });
    await userEvent.click(card.querySelector('button[data-path="src/b.ts"]') as HTMLButtonElement);
    expect(flyToPath).toHaveBeenCalledWith('src/b.ts');
    expect(cityProps?.selectedPath).toBe('src/b.ts');
  });

  it('selecting a building in the canvas updates details; empty ground clears it', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    act(() => cityProps?.onSelect?.({ kind: 'building', path: 'src/a.ts' }));
    expect(screen.getByRole('link', { name: /GitHub/ }).getAttribute('href')).toContain(
      `/blob/${'b'.repeat(40)}/src/a.ts`,
    );
    act(() => cityProps?.onSelect?.(null));
    expect(screen.getByText(/select a file/i)).toBeTruthy();
  });

  it('flagged district tooltip reads single owner: <name> (<share>%); unflagged shows none', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    expect(cityProps?.tooltipText?.({ kind: 'district', path: 'src' })).toBe(
      'single owner: Ada Lovelace (86%)',
    );
    const plain = cityProps?.tooltipText?.({ kind: 'district', path: 'docs' }) ?? '';
    expect(plain).not.toMatch(/single owner/);
    expect([...(cityProps?.badgedDistricts ?? [])]).toEqual(['src']);
  });

  it('changes the colour mode and the legend with the picker', async () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    const before = cityProps?.colours;
    await userEvent.selectOptions(screen.getByLabelText(/colour by/i), 'age');
    expect(cityProps?.colours).not.toBe(before);
    expect(screen.getByText('30 days or less')).toBeTruthy();
  });

  it('keeps the colour array parallel to the buildings', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    expect(cityProps?.colours).toHaveLength(cityProps?.layout.buildings.length ?? -1);
  });

  it('has the landmarks', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    expect(screen.getByRole('banner')).toBeTruthy();
    expect(screen.getByRole('main')).toBeTruthy();
    expect(screen.getAllByRole('complementary')).toHaveLength(2);
  });

  it('passes treemap props in 2D mode', async () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    await userEvent.click(screen.getByRole('button', { name: '2D' }));
    expect(treemapProps?.files).toHaveLength(4);
    expect(treemapProps?.colourOf('src/a.ts')).toMatch(/^#[0-9a-f]{6}$/i);
  });
});

describe('ViewerLoader', () => {
  it('requests the lower-case route and renders the viewer when ready', async () => {
    const fetchMock = vi.fn<(url: string) => Promise<Response>>(() =>
      Promise.resolve(Response.json({ source: 'live', analysedAt: null, analysis })),
    );
    vi.stubGlobal('fetch', fetchMock);
    render(<ViewerLoader owner="Octo" repo="Repo" />);
    await waitFor(() => expect(screen.getByTestId('city')).toBeTruthy());
    expect(fetchMock.mock.calls[0]?.[0] as string).toBe('/api/analysis/octo/repo');
  });

  it('shows a not-analysed state with a link home on 404', async () => {
    vi.stubGlobal('fetch', () =>
      Promise.resolve(
        Response.json({ error: 'analysis_not_found', message: 'x' }, { status: 404 }),
      ),
    );
    render(<ViewerLoader owner="octo" repo="repo" />);
    await waitFor(() => expect(screen.getByText(/not analysed yet/i)).toBeTruthy());
    expect(screen.getByRole('link', { name: /gallery/i }).getAttribute('href')).toBe('/');
    // The uncached repo offers the analyse form, prefilled.
    expect((screen.getByLabelText(/github repository/i) as HTMLInputElement).value).toBe(
      'octo/repo',
    );
  });

  it('shows a loading status first, and an error message on failure', async () => {
    vi.stubGlobal('fetch', () => Promise.reject(new Error('offline')));
    render(<ViewerLoader owner="octo" repo="repo" />);
    expect(screen.getByRole('status')).toBeTruthy();
    await waitFor(() => expect(screen.getByRole('alert')).toBeTruthy());
  });
});

describe('Viewer: arcs, states and accessibility', () => {
  it('draws arcs for the selected file only, and none when nothing is selected', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    expect(cityProps?.arcs).toEqual([]);
    act(() => cityProps?.onSelect?.({ kind: 'building', path: 'src/a.ts' }));
    expect(cityProps?.arcs).toHaveLength(1);
    expect(cityProps?.arcs?.[0]?.path).toBe('src/b.ts');
    // A file with no partners gets no arcs.
    act(() => cityProps?.onSelect?.({ kind: 'building', path: 'docs/old file #1.md' }));
    expect(cityProps?.arcs).toEqual([]);
    act(() => cityProps?.onSelect?.(null));
    expect(cityProps?.arcs).toEqual([]);
  });

  it('shows the thin-history note in every history-based mode, and not in language mode', async () => {
    render(
      <Viewer analysis={viewerAnalysis({ thinHistory: true })} source="live" analysedAt={null} />,
    );
    for (const mode of ['hotspot', 'churn', 'age', 'bugfix', 'ownership']) {
      await userEvent.selectOptions(screen.getByLabelText(/colour by/i), mode);
      expect(screen.getByText(/thin history/i)).toBeTruthy();
    }
    await userEvent.selectOptions(screen.getByLabelText(/colour by/i), 'language');
    expect(screen.queryByText(/thin history/i)).toBeNull();
  });

  it('has no thin-history note for a repo with enough commits', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    expect(screen.queryByText(/thin history/i)).toBeNull();
  });

  it('without WebGL shows the 2D treemap and an explanation, and disables the 3D button', () => {
    webgl.ok = false;
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    expect(screen.getByTestId('treemap')).toBeTruthy();
    expect(screen.queryByTestId('city')).toBeNull();
    expect(screen.getByText(/needs WebGL/i)).toBeTruthy();
    expect((screen.getByRole('button', { name: '3D' }) as HTMLButtonElement).disabled).toBe(true);
  });

  it('announces the selection politely', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    act(() => cityProps?.onSelect?.({ kind: 'building', path: 'src/a.ts' }));
    expect(screen.getByText('Selected src/a.ts').getAttribute('aria-live')).toBe('polite');
  });

  it('Escape closes the details sheet and returns focus to its button', async () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    const button = screen.getByRole('button', { name: /report card and details/i });
    await userEvent.click(button); // opens
    expect(button.getAttribute('aria-expanded')).toBe('true');
    const entry = document.querySelector('button[data-path="src/a.ts"]') as HTMLButtonElement;
    entry.focus();
    await userEvent.keyboard('{Escape}');
    expect(button.getAttribute('aria-expanded')).toBe('false');
    expect(document.activeElement).toBe(button);
  });

  it('moves focus to the main region on mount, and has a heading hierarchy from h1', () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    expect(document.activeElement).toBe(screen.getByRole('main'));
    expect(screen.getAllByRole('heading', { level: 1 })).toHaveLength(1);
    expect(screen.getByRole('main').id).toBe('main');
  });

  it('selecting in the 2D view opens the details sheet', async () => {
    render(<Viewer analysis={analysis} source="live" analysedAt={null} />);
    await userEvent.click(screen.getByRole('button', { name: '2D' }));
    const button = screen.getByRole('button', { name: /report card and details/i });
    expect(button.getAttribute('aria-expanded')).toBe('false');
    act(() => treemapProps?.onSelect?.('src/a.ts'));
    expect(button.getAttribute('aria-expanded')).toBe('true');
  });

  it('repo-derived strings render as text, never as elements', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const base = viewerAnalysis();
    const hostile = {
      ...base,
      files: base.files.map((f, i) =>
        i === 0
          ? { ...f, path: evil, mainAuthor: evil, coChange: [{ path: evil, shared: 1, score: 1 }] }
          : f,
      ),
      report: { ...base.report, readFirst: [evil] },
    };
    const { container } = render(<Viewer analysis={hostile} source="live" analysedAt={null} />);
    act(() => cityProps?.onSelect?.({ kind: 'building', path: evil }));
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText(evil, { exact: false }).length).toBeGreaterThan(0);
  });
});
