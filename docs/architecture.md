# Architecture

Diagrams for Codebase City as built. The reasoning and the safety rules are in `docs/superpowers/specs/2026-11-13-codebase-city-design.md` (sections 5, 6 and 10).

## System context

```mermaid
flowchart LR
    V[Visitor] -->|open city, no password| P[Next.js app on Vercel]
    P -->|gallery JSON, static files| V
    P -->|read cached analysis| DB[(Neon Postgres)]
    V -->|password and repo URL| P
    P -->|repo facts and file sizes| GH[GitHub API]
    P -->|create job, no secrets| S[Vercel Sandbox]
    S -->|git clone and git log| GHG[github.com]
    S -->|Analysis JSON on stdout| P
    P -->|validate, store| DB
```

## Where the viewer reads data

The viewer never calls GitHub or starts a job. A repo that is not cached shows the password prompt.

```mermaid
flowchart TD
    R["/r/owner/repo"] --> A["GET /api/analysis/owner/name (public)"]
    A --> G{"File in public/gallery?"}
    G -->|yes| OK[Stream the Analysis]
    G -->|no| D{"Row in Postgres for this schema version?"}
    D -->|yes| OK
    D -->|no| NF["404 analysis_not_found, show the analyse form"]
    OK --> VW["Viewer: 3D city and 2D treemap"]
```

## Live analysis flow

```mermaid
sequenceDiagram
    participant B as Browser
    participant X as proxy.ts and route
    participant GH as GitHub API
    participant DB as Postgres
    participant S as Sandbox
    B->>X: POST /api/analyze (cookie)
    X-->>B: 401 if no valid session
    X->>X: gallery hit? then answer cached
    X->>GH: repo facts, head SHA, tree sizes
    X->>DB: same head SHA cached? then answer cached
    X->>X: check caps, reserve quota, create job
    X-->>B: job id
    X->>S: run bundled job (after response)
    S-->>X: Analysis JSON
    X->>X: validate against the schema
    X->>DB: store analysis, mark job done
    loop every 2 seconds
        B->>X: GET /api/jobs/id
        X-->>B: phase or error code
    end
    B->>X: GET /api/analysis/owner/name
```

## Modules

```mermaid
flowchart LR
    subgraph web[Web app]
        API["app/api: analyze, jobs, session, analysis"]
        PX[proxy.ts and lib/gate.ts]
        SES[lib/session.ts and login limit]
        GHC[lib/repo: GitHub facts and caps]
        DBL[lib/db: cache, jobs, quota]
        UI["app and components: viewer, gallery"]
        LAY[lib/layout: city and treemap]
        REN[lib/render: Three.js scene, colours, arcs]
    end
    subgraph job[Sandbox job, bundled]
        JOB[lib/sandbox/job.ts]
        ING[lib/ingest: parseLog, metrics, cochange, report]
    end
    SCH[lib/analysis: types and schema]
    GAL[scripts/build-gallery.ts]
    PX --> SES
    API --> PX
    API --> GHC
    API --> DBL
    API --> JOB
    JOB --> ING
    ING --> SCH
    API --> SCH
    GAL --> JOB
    GAL --> GHC
    UI --> LAY
    UI --> REN
    UI --> SCH
```

## Access gate

```mermaid
flowchart TD
    Q[Request to /api/...] --> N{"isGatedPath after normalising: /api/analyze or /api/jobs?"}
    N -->|no| PUB["Public: gallery, viewer data, login"]
    N -->|yes| C{"Valid signed session cookie?"}
    C -->|no| U[401 unauthorized]
    C -->|yes| H["Route handler checks the session again"]
```
