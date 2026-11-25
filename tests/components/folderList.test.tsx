// @vitest-environment jsdom
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { FOLDER_ROWS, FolderList } from '@/components/FolderList';

afterEach(cleanup);

const noop = () => {};

describe('FolderList', () => {
  it('sorts largest first and shows counts', () => {
    render(
      <FolderList
        folders={[
          { path: 'docs', files: 3 },
          { path: 'src', files: 40 },
        ]}
        chosenPath={null}
        onPreview={noop}
        onChoose={noop}
      />,
    );
    const rows = screen.getAllByRole('button').map((b) => b.getAttribute('data-path'));
    expect(rows).toEqual(['src', 'docs']);
  });

  it('shows at most FOLDER_ROWS rows and says how many are not listed', () => {
    const folders = Array.from({ length: FOLDER_ROWS + 5 }, (_, i) => ({
      path: 'd' + String(i).padStart(3, '0'),
      files: 1,
    }));
    render(<FolderList folders={folders} chosenPath={null} onPreview={noop} onChoose={noop} />);
    expect(screen.getAllByRole('button')).toHaveLength(FOLDER_ROWS);
    expect(screen.getByText(/5 smaller folders not listed/)).toBeTruthy();
  });

  it('renders hostile folder names as text', () => {
    render(
      <FolderList
        folders={[{ path: '<img src=x onerror=alert(1)>', files: 1 }]}
        chosenPath={null}
        onPreview={noop}
        onChoose={noop}
      />,
    );
    expect(document.querySelector('img')).toBeNull();
    expect(screen.getByText('<img src=x onerror=alert(1)>')).toBeTruthy();
  });
});
