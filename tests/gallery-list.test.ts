import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { listGalleryCards } from '@/lib/gallery';
import { viewerAnalysis } from './helpers/viewerFixture';

let dir = '';
afterEach(async () => {
  if (dir) await rm(dir, { recursive: true, force: true });
});

describe('listGalleryCards', () => {
  it('returns [] for a missing directory', async () => {
    expect(await listGalleryCards(join(tmpdir(), 'no-such-gallery-dir-xyz'))).toEqual([]);
  });

  it('builds a card per valid analysis and skips bad files', async () => {
    dir = await mkdtemp(join(tmpdir(), 'gallery-'));
    await writeFile(join(dir, 'octo__repo.json'), JSON.stringify(viewerAnalysis()));
    await writeFile(join(dir, 'broken__x.json'), '{not json');
    await writeFile(join(dir, 'readme.txt'), 'ignore me');
    const cards = await listGalleryCards(dir);
    expect(cards.map((c) => `${c.owner}/${c.name}`)).toEqual(['octo/repo']);
  });
});
