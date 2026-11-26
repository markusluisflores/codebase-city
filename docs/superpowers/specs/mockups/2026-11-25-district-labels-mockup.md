# District labels mockup (2026-11-25)

Markus's first-use feedback: he had no idea how buildings were grouped and suggested labels on the floor. Options were shown as ASCII sketches and the decisions are below. Related: `docs/superpowers/specs/2026-11-13-codebase-city-design.md` section 9 and `docs/superpowers/specs/mockups/2026-11-17-viewer-mockup.md`.

## Consistency audit

- Layout A stays: full-bleed canvas, left report card, right details. The folder list goes in the left panel under the report card (the text-first side of the viewer), collapsed by default.
- Text is Fira Code, the face already used for paths; colour is `--text` (`#e6eaf5`) with a `--bg` halo, so it reads on the `#131a2e` floor and over coloured buildings. No new colours.
- Orange (`#fb923c`) already means "single-owner outline", so the list highlight is a tint plus a pale outline, not a second orange outline.
- Canvas content is decorative. The folder list and the report card are the text alternatives.

## Platform research

Map products (Google Maps, Mapbox) fade labels in by zoom and label only large areas. Disk-usage treemaps (WinDirStat, Disk Inventory X) print the folder name inside big rectangles, cut to fit. Code-visualisation tools (CodeCharta, CodeScene) rely on hover and a side tree.

## Option A: labels only (rejected)

```
 3D:                                    2D:
 +--------------------------+           +-----------------------+
 |  src/util   | tests/     |           | tests/testsuite       |
 |  ||||||||    |  ||||||    |           +-----------+-----------+
 |------------+             |           | doc/book  | doc/man   |
 |  doc/book  |             |           +-----------+-----------+
 +--------------------------+
```

Why rejected: small districts stay anonymous and nothing gives a text version of the grouping.

## Option B: folder list only (rejected)

```
 +-------------------+--------------+
 | canvas (district  | FOLDERS      |
 |  lit on hover)    | > tests 2230 |
 |                   |   src     49 |
 +-------------------+--------------+
```

Why rejected: viewers must look away from the city to learn what they are looking at.

## Option C: labels plus folder list ✅ CHOSEN

Name labels for big districts in both views, plus a collapsed `Folders` section in the left panel. Hover or focus a row to tint that district in both views; click to keep the tint and, in 3D, fly the camera there.

```
 +-----------+----------------------------------+---------------+
 | REPORT    |   src/util        tests/testsuite|  DETAILS      |
 | CARD      |      (labels float over the      |               |
 | ...       |       floor, 12 at most)         |               |
 | v Folders |                                  |               |
 |  tests 2230                                  |               |
 |  doc/book 112                                |               |
 +-----------+----------------------------------+---------------+
```

### Label rules

- Candidates: leaf districts only (a folder with a district below it is not labelled; its children are), never a `(files)` pseudo-district.
- Shown only when the district is at least 60 px wide and 16 px tall on screen, at most 12 at once, the largest on screen first; a label that would overlap one already chosen is dropped.
- Text is the full path if it fits, else the last folder name, else that name cut with an ellipsis (at least 6 characters, otherwise no label).
- 3D: the label is centred on the district and fades in from 60 px to 96 px wide, so labels appear as the viewer zooms in. A pool of 12 DOM elements, moved after each rendered frame; the single instanced mesh is untouched. 2D: drawn into the canvas at the top-left of the district's rectangle.
- Labels are `aria-hidden` and take no part in picking.

## Decisions

| Question | Chosen | Why | Tradeoff accepted |
| -------- | ------ | --- | ----------------- |
| Q1 Which option (Markus, 2026-11-25) | C: labels plus folder list | Labels answer "what is this block" at a glance; the list covers small districts and gives a text version | Most surface area: scene, treemap, panel, tests |
| Q2 Label cap (Markus, 2026-11-25) | About 12 at once | Cleaner view | Big repos such as django show only their largest districts |
| Q3 List click (Markus, 2026-11-25) | Click flies the camera, hover only highlights | Hover stays safe; flying is an explicit act | In 2D a click only keeps the tint |
| Q4 Label technique (my call) | DOM overlay in 3D, canvas text in 2D | Crisp text, no per-frame text rendering, no new dependency | Labels face the screen rather than lying flat on the floor, and are not hidden behind buildings |
| Q5 List size (my call) | 40 largest folders, then a "N smaller folders" note | Keeps the panel short on phones | Small folders are not listed; search finds their files |

## Implementation handoff

UI work for this feature invoked the `frontend-design` skill before writing components.
