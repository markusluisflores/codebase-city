# Viewer design mockup (2026-11-17)

Approved by Markus on 2026-11-17 through the design-process skill: every option was shown with an ASCII mockup and a rendered palette page. The decisions are in the [Decisions](#decisions) table; the rest of this file keeps the rejected options visible so the reasoning survives.

Related: `docs/superpowers/specs/2026-11-13-codebase-city-design.md`.

## 1. Viewer page layout

### Option A: full-bleed canvas with side panels ✅ CHOSEN

The canvas fills the page. The report card sits in a left panel, details for the selected file in a right panel, and the repo name, 3D/2D toggle and search in a top bar. The legend and the colour-mode picker float over the canvas.

```
+--------------------------------------------------------------+
| owner/repo        [3D | 2D]                      [ Search ]  |
+-----------+----------------------------------+---------------+
| REPORT    |                                  | DETAILS       |
| CARD      |                                  | src/app.ts    |
|           |        3D city / 2D treemap      | churn   42    |
| 1 a.ts    |          (full-bleed canvas)     | age     3 yr  |
| 2 b.ts    |                                  | owners  2     |
| 3 c.ts    |                                  | co-changes    |
|           |  [Mode: Hotspot v]   [legend]    |  d.ts  0.8    |
+-----------+----------------------------------+---------------+
```

Phones: the canvas is full screen and both panels become a bottom sheet.

```
+------------------+
| owner/repo  [3D] |
+------------------+
|                  |
|  canvas          |
|  (full screen)   |
|                  |
|[Mode v]  [legend]|
+------------------+
| ---  sheet  ---  |
| Report card      |
| Details          |
+------------------+
```

### Option B: fixed three-column dashboard (rejected)

```
+--------------------------------------------------------------+
| owner/repo   [3D | 2D]                         [ Search ]    |
+-----------+------------------------+-------------------------+
| REPORT    |                        | DETAILS                 |
| CARD      |     canvas (smaller)   |                         |
|           |                        | LEGEND / MODE           |
+-----------+------------------------+-------------------------+
```

Why rejected: the canvas is the product and this shrinks it permanently. It also needs a separate phone layout, so two designs to build and test.

### Option C: canvas with floating cards (rejected)

```
+--------------------------------------------------------------+
|  [owner/repo]                                   [3D|2D][ ?]  |
|    +---------+                                 +----------+  |
|    | REPORT  |      canvas                     | DETAILS  |  |
|    | CARD    |                                 +----------+  |
|    +---------+          [legend]  [Mode v]                    |
+--------------------------------------------------------------+
```

Why rejected: cards cover buildings, and floating, overlapping regions are harder to make keyboard and screen-reader friendly than fixed panels.

## 2. Gallery home

```
+--------------------------------------------------------------+
| Codebase City                                                |
| See any repo as a city. Find the files to read first.        |
|                                                              |
| [ https://github.com/owner/repo          ] [ Analyse ]       |
| Repos outside the gallery need the demo password.            |
|                                                              |
| +----------+  +----------+  +----------+                     |
| | thumb    |  | thumb    |  | thumb    |                     |
| | owner/a  |  | owner/b  |  | owner/c  |                     |
| | TypeScript| | Python   |  | Go       |                     |
| | 2026-11-14| | 2026-11-15| | 2026-11-16|                     |
| +----------+  +----------+  +----------+                     |
+--------------------------------------------------------------+
```

- Hero line, then the gated analyse form: URL input and an `Analyse` button, with the note that repos outside the gallery need the demo password.
- Grid of cards: thumbnail, repo name, language, analysed date.
- Empty state text: `No repos yet. Analyse one above.`
- Clicking a card opens that repo's viewer. Cards are served from stored results, so browsing costs no analysis quota.

## 3. Palette

Dark tokens (shared by all three options):

| Token | Hex |
| ----- | --- |
| bg | `#0b1020` |
| surface | `#131a2e` |
| text | `#e6eaf5` |
| muted | `#94a3b8` |
| border | `#2a3350` |
| accent | `#fb923c` (Night Ember) |
| cold | `#6b7280` |

Rendered comparison: `docs/superpowers/specs/mockups/2026-11-17-viewer-palette.html` and `docs/superpowers/specs/mockups/2026-11-17-viewer-palette.pdf`.

| Option | Sequential ramp (cold to hot) | Accent | Verdict |
| ------ | ----------------------------- | ------ | ------- |
| A Night Ember ✅ CHOSEN | `#280b54 #65156e #9f2a63 #d44842 #f57d15 #fac127 #fcffa4` | `#fb923c` | Chosen: ramp stays legible on the dark background and reads as heat |
| B Deep Sea | `#482878 #3e4989 #26828e #1f9e89 #6ece58 #b5de2b #fde725` | `#2dd4bf` | Rejected: viridis-style, accessible, but cool tones do not say "hot" |
| C Paper Heat | `#ffffb2 #fed976 #feb24c #fd8d3c #f03b20 #bd0026 #800026` | `#f87171` on dark | Rejected: weak on dark, the darkest reds sink into the background |

Categorical palette (language and ownership modes), Okabe-Ito, colour-blind safe: `#E69F00 #56B4E9 #009E73 #F0E442 #0072B2 #D55E00 #CC79A7 #999999`.

## 4. Fonts

Specimen: `docs/superpowers/specs/mockups/2026-11-17-viewer-fonts.html` and `docs/superpowers/specs/mockups/2026-11-17-viewer-fonts.pdf`.

- **Fira Sans + Fira Code via `next/font/google`** ✅ CHOSEN. Self-hosted at build time, so no runtime request to Google. Fira Code suits file paths and numbers.
- System font stack (rejected): fastest and native, but a less technical look.

## 5. Theme

Dark only for v1 ✅ CHOSEN. All colours are CSS custom properties (the tokens above), so a light set can be added later without touching components.

## Decisions

All approved by Markus on 2026-11-17.

| Question | Chosen | Why | Tradeoff accepted |
| -------- | ------ | --- | ----------------- |
| Q1 Layout (2026-11-17) | A: full-bleed canvas, left report card, right details, top bar; bottom sheet on phones | The canvas is the product; one layout scales to phones | Panels take width on small laptops; bottom sheet needs its own interaction work |
| Q2 Theme (2026-11-17) | Dark only, tokens as CSS custom properties | Heat colours read best on dark; half the testing | No light mode in v1 |
| Q3 Palette (2026-11-17) | A Night Ember ramp, Okabe-Ito categorical | Legible on dark, reads as heat, colour-blind-safe categories | Less conventional than viridis |
| Q4 Fonts (2026-11-17) | Fira Sans + Fira Code via `next/font/google` | Technical look, self-hosted at build | Font files add page weight over the system stack |
| Q5 Gallery home (2026-11-17) | Hero, gated analyse form, card grid, empty state | Browsing is free (stored results); only new repos are gated | Thumbnails must be generated and stored per analysis |

## Research

CodeScene's hotspot docs (https://docs.enterprise.codescene.io/versions/4.0.1/guides/technical/hotspots.html), CodeCharta (https://github.com/thorsten/codecharta) and Code Map (https://github.com/Peeter95/code-map/wiki) were reviewed for how hotspot views are presented. Findings used here: treemaps have weak accessibility, so the report card is the text-first equivalent of the canvas; and heatmaps need a numeric legend, not colour alone.

## Implementation handoff

UI tasks (14 onward) must invoke the `frontend-design` skill before writing components, and `dataviz` for charts and legends.
