// @vitest-environment jsdom
import { cleanup, render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DetailsPanel } from '@/components/DetailsPanel';
import { Legend } from '@/components/Legend';
import { ReportCard } from '@/components/ReportCard';
import { SearchBox } from '@/components/SearchBox';
import { githubFileUrl } from '@/lib/links';
import { COLOUR_MODES, buildColourContext } from '@/lib/render/colours';
import { NOW, fileStat, viewerAnalysis } from '../helpers/viewerFixture';

afterEach(cleanup);

const repo = { owner: 'octo', name: 'repo' };
const SHA = 'b'.repeat(40);

describe('DetailsPanel', () => {
  it('shows size, changes, last changed, bug-fix commits, main author and the GitHub link', () => {
    const file = fileStat({ path: 'my dir/a#b.ts', size: 2048, changes: 12, bugFixes: 4 });
    render(<DetailsPanel file={file} repo={repo} headSha={SHA} now={NOW} />);
    expect(screen.getByText('my dir/a#b.ts')).toBeTruthy();
    expect(screen.getByText('2.0 KB')).toBeTruthy();
    expect(screen.getByText('12')).toBeTruthy();
    expect(screen.getByText('3 days ago')).toBeTruthy();
    expect(screen.getByText('4')).toBeTruthy();
    expect(screen.getByText(/Ada Lovelace/)).toBeTruthy();
    const link = screen.getByRole('link', { name: /GitHub/ });
    expect(link.getAttribute('href')).toBe(githubFileUrl(repo, SHA, 'my dir/a#b.ts'));
    expect(link.getAttribute('rel')).toContain('noopener');
  });

  it('says "older than window" for lastChanged null', () => {
    render(
      <DetailsPanel
        file={fileStat({ lastChanged: null, changes: 0, mainAuthor: null, authors: [] })}
        repo={repo}
        headSha={SHA}
        now={NOW}
      />,
    );
    expect(screen.getByText('older than window')).toBeTruthy();
    expect(screen.getByText(/no author in the window/i)).toBeTruthy();
  });

  it('shows a prompt when nothing is selected', () => {
    render(<DetailsPanel file={null} repo={repo} headSha={SHA} now={NOW} />);
    expect(screen.getByText(/select a file/i)).toBeTruthy();
  });

  it('renders a hostile path and author name as literal text', () => {
    const bad = '<img src=x onerror=alert(1)>';
    const { container } = render(
      <DetailsPanel
        file={fileStat({ path: bad, mainAuthor: bad })}
        repo={repo}
        headSha={SHA}
        now={NOW}
      />,
    );
    expect(container.querySelector('img')).toBeNull();
    expect(screen.getAllByText((t) => t.includes(bad)).length).toBeGreaterThan(0);
  });
});

describe('Legend', () => {
  const a = viewerAnalysis();
  const ctx = buildColourContext(a.files, NOW);

  it.each(COLOUR_MODES)('shows the rename-history note in %s mode', (mode) => {
    render(<Legend mode={mode} ctx={ctx} stats={a.stats} />);
    expect(screen.getByText(/renames split a file's history/i)).toBeTruthy();
  });

  it('shows the repo-wide bug-fix match rate as a percentage, 0 as 0%', () => {
    const { rerender } = render(<Legend mode="bugfix" ctx={ctx} stats={a.stats} />);
    expect(screen.getByText(/match rate: 20%/i)).toBeTruthy();
    rerender(<Legend mode="bugfix" ctx={ctx} stats={{ ...a.stats, bugFixCommitShare: 0 }} />);
    expect(screen.getByText(/\b0%/)).toBeTruthy();
  });

  it('shows the aliases note only when mailmapApplied is false', () => {
    const { rerender } = render(
      <Legend mode="ownership" ctx={ctx} stats={{ ...a.stats, mailmapApplied: false }} />,
    );
    expect(screen.getByText(/aliases are not merged/i)).toBeTruthy();
    rerender(<Legend mode="ownership" ctx={ctx} stats={{ ...a.stats, mailmapApplied: true }} />);
    expect(screen.queryByText(/aliases are not merged/i)).toBeNull();
  });

  it('lists every stop with its text and the heuristic note', () => {
    render(<Legend mode="age" ctx={ctx} stats={a.stats} />);
    expect(screen.getByText('older than window')).toBeTruthy();
    expect(screen.getByText(/heuristic/i)).toBeTruthy();
  });
});

describe('ReportCard', () => {
  const a = viewerAnalysis();

  it('lists the three groups and calls onSelect with the path', async () => {
    const onSelect = vi.fn();
    render(<ReportCard report={a.report} onSelect={onSelect} selectedPath={null} />);
    const first = screen.getByRole('region', { name: /read first/i });
    await userEvent.click(within(first).getByRole('button', { name: /src\/b\.ts/ }));
    expect(onSelect).toHaveBeenCalledWith('src/b.ts');
    expect(screen.getByRole('region', { name: /riskiest/i })).toBeTruthy();
    expect(screen.getByRole('region', { name: /forgotten/i })).toBeTruthy();
  });

  it('selects an entry with the keyboard', async () => {
    const onSelect = vi.fn();
    render(<ReportCard report={a.report} onSelect={onSelect} selectedPath={null} />);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenCalledWith('src/a.ts');
  });

  it('marks the selected entry', () => {
    render(<ReportCard report={a.report} onSelect={() => {}} selectedPath="src/b.ts" />);
    expect(screen.getAllByRole('button', { pressed: true })).toHaveLength(1);
  });
});

describe('SearchBox', () => {
  const paths = viewerAnalysis().files.map((f) => f.path);

  it('shows matches and selects one on click', async () => {
    const onSelect = vi.fn();
    render(<SearchBox paths={paths} onSelect={onSelect} />);
    await userEvent.type(screen.getByRole('combobox'), 'read');
    await userEvent.click(screen.getByRole('option', { name: /docs\/readme\.md/ }));
    expect(onSelect).toHaveBeenCalledWith('docs/readme.md');
  });

  it('selects with the keyboard (Enter picks the highlighted result)', async () => {
    const onSelect = vi.fn();
    render(<SearchBox paths={paths} onSelect={onSelect} />);
    await userEvent.type(screen.getByRole('combobox'), 'src/');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('src/b.ts');
  });

  it('says when nothing matches', async () => {
    render(<SearchBox paths={paths} onSelect={() => {}} />);
    await userEvent.type(screen.getByRole('combobox'), 'zzz');
    expect(screen.getByText(/no files match/i)).toBeTruthy();
  });
});

describe('keyboard use', () => {
  it('search: type, arrow to a result and press Enter to select it', async () => {
    const onSelect = vi.fn();
    render(<SearchBox paths={['src/a.ts', 'src/b.ts', 'docs/a.md']} onSelect={onSelect} />);
    await userEvent.tab();
    expect(document.activeElement).toBe(screen.getByRole('combobox'));
    await userEvent.keyboard('src');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(onSelect).toHaveBeenCalledWith('src/b.ts');
  });

  it('search: Enter with no list open selects nothing', async () => {
    const onSelect = vi.fn();
    render(<SearchBox paths={['src/a.ts']} onSelect={onSelect} />);
    await userEvent.tab();
    await userEvent.keyboard('{Enter}');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('report card: entries are tabbable buttons and Enter or Space selects', async () => {
    const onSelect = vi.fn();
    const report = { readFirst: ['src/a.ts', 'src/b.ts'], riskiest: [], forgotten: [] };
    render(<ReportCard report={report} selectedPath={null} onSelect={onSelect} />);
    await userEvent.tab();
    expect(document.activeElement?.getAttribute('data-path')).toBe('src/a.ts');
    await userEvent.keyboard('{Enter}');
    expect(onSelect).toHaveBeenLastCalledWith('src/a.ts');
    await userEvent.tab();
    await userEvent.keyboard(' ');
    expect(onSelect).toHaveBeenLastCalledWith('src/b.ts');
  });
});
