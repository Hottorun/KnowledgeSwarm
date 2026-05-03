# KnowledgeSwarm — Frontend

## Stack
- React 19 + Vite 7 + TanStack Router (file-based, SSR via TanStack Start)
- Sigma.js + Graphology for the graph canvas
- Framer Motion v12 for animations
- Tailwind CSS v4 with OKLCH color tokens
- Bun as package manager (`bun install`, `bun run dev`)
- Deployed to Cloudflare Workers (`wrangler.json`)

## Project layout
```
src/
  routes/
    __root.tsx          # Root layout + error boundary
    index.tsx           # Single route — renders <KnowledgeGraphCanvas />
  components/
    knowledge-graph/
      KnowledgeGraphCanvas.tsx  # Top-level orchestrator (state, refs, panels, JSX)
      useGraphSSE.ts            # SSE event handler — node.created / edge.created / source.created / agent.step
      useExpansion.ts           # handleNodeAction — expand-subtree queue, context bundle, anchor management
      layout.ts                 # forceDirectedLayout + resolveOverlaps
      SigmaGraphView.tsx        # Sigma/Graphology whole-graph renderer
      presentationGraph.ts      # buildPresentationView, isMainEntityNode, etc.
      graphTypes.ts             # GraphNode/GraphEdge types + node sizing helpers
      AnimatedBlob.tsx          # Landing blob + LoadingBlob (loading overlay)
      NodeInputBox.tsx          # Node action popup (Expand, Research, Connections)
      SidePanel.tsx             # Left (TOC) + Right (Reasoning) drawers
      TopNav.tsx                # Header
      EdgeButton.tsx            # Sidebar toggle buttons
      TocDropdown.tsx           # TOC dropdown
      APIKeyModal.tsx           # OpenAI key modal
      types.ts                  # AIReasoningStep, DataSource
    ui/                         # shadcn/ui components (don't edit manually)
  lib/
    api.ts              # All backend calls (createRun, openRunStream, extractFromText, expandSubtree)
    utils.ts            # cn() utility
  hooks/
    use-mobile.tsx
  styles.css            # Design tokens (OKLCH), blob-morph/blob-pulse/node-breathe keyframes
  router.tsx            # TanStack Router config
  routeTree.gen.ts      # AUTO-GENERATED — never edit
```

## Key state in KnowledgeGraphCanvas
| State | Purpose |
|-------|---------|
| `isEmpty` | true until first run is submitted |
| `isDissolving` | true during blob dissolve + extractFromText call |
| `isProcessing` | true from submit until layout commits nodes; drives `<LoadingBlob>` |
| `nodes / edges` | Local `GraphNode[]` / `GraphEdge[]` state rendered by Sigma |
| `runId` | current backend run ID |
| `reasoningSteps` | agent.step SSE events shown in right panel |

## Submit → graph flow
1. `handleDataSubmit(text)` → `setIsDissolving(true)`, `setIsProcessing(true)`
2. `createRun(text)` → returns `runId`
3. `connectRunStream(runId)` — opens EventSource SSE
4. `setIsEmpty(false)`
5. `extractFromText(runId, text)` — POST that triggers AI extraction (awaited; results come via SSE)
6. `finally` → `setIsDissolving(false)` (safety fallback)
7. SSE `node.created` / `edge.created` → buffered in `pendingNodesRef` / `pendingEdgesRef`
8. After burst settles (600ms debounce) → layout runs on full buffer, then `setNodes` + `setEdges` called once, `setIsProcessing(false)`
9. Nodes appear for the first time already in their final sorted positions

## Expansion flow (user clicks expand on a node)
- `expansionAnchorRef` is set to the clicked node
- SSE events are committed immediately (not buffered) so user sees progress
- After 600ms debounce → layout re-runs on committed nodes only (no fitView)

## SSE events handled (`useGraphSSE.ts`)
- `node.created` → buffered (initial load) or committed immediately (expansion / query / append)
- `edge.created` → buffered (initial load) or committed immediately (expansion / query / append)
- `source.created` → merge `BackendSource` into the matching edge's `data.sources`
- `agent.step` / `run.status` → append to reasoningSteps

The SSE handler lives in `useGraphSSE.ts` and is wired into the canvas with `useGraphSSE({ setters, refs, helpers })`. The expansion queue + `handleNodeAction` lives in `useExpansion.ts`. Both hooks receive shared expansion refs (`expansionAnchorRef`, `expansionChildIdxRef`, `expansionDepthRef`, `expansionNewNodesRef`) declared in the canvas — the SSE handler reads them, the expansion queue writes them.

## Key refs (KnowledgeGraphCanvas.tsx)
| Ref | Purpose |
|-----|---------|
| `pendingNodesRef` | Buffer for initial-load SSE nodes — cleared on commit |
| `pendingEdgesRef` | Buffer for initial-load SSE edges — cleared on commit |
| `nodesRef` | Mirror of committed `nodes` state for SSE dedup checks |
| `edgesRef` | Mirror of committed `edges` state for layout debounce |
| `expansionAnchorRef` | Set during node expansion; null during initial load |
| `layoutDebounceRef` | 600ms debounce timer for layout commit |

## Layout algorithm (`layout.ts`)
- `forceDirectedLayout`: Coulomb repulsion + Hooke springs, 450 iterations, root nodes pinned at origin; connected nodes attract, unconnected repel
- `resolveOverlaps`: AABB iterative collision resolution using actual node dimensions + NODE_GAP=14px, up to 1000 iterations; guarantees zero overlap (user-dragged positions are exempt)
- Combined as `layout()` — always run as `resolveOverlaps(forceDirectedLayout(nodes, edges))`
- Run off-main-thread via `src/workers/layout.worker.ts`; the canvas's `runLayoutAsync` posts to it and falls back to sync `layout()` if the worker isn't ready

## Node types & sizing (`graphTypes.ts` → `nodeDims`)
```
root     → 210×76px, semibold, dot 40px  (depth 0)
topic    → 175×62px, medium,   dot 32px  (depth 1)
subtopic → 130×46px, medium,   dot 22px  (depth 2)
detail   → 110×40px, regular,  dot 18px  (depth 3+)
```
Char widths used for label-fit calculations: root 8, topic 7, subtopic 6.5, detail 6 (`charWidths`). Labels wrap past 25 chars (`LABEL_WRAP_AT`). When a description badge is present, the box gets `BADGE_WALL_CLEARANCE=12px` of extra right padding.

## Entity type → color (`SigmaGraphView.tsx`)
OKLCH soft-pastel palette. Each entity carries `{ dot, glow, tint, text }` — dot is opaque, glow at 22% alpha, tint at 8% alpha, text is a darker shade for legibility. Mapping is *substring* (`description.toLowerCase().includes(key)`), so `Company` matches `"Company"` and `"Holding Company"` alike.

| Type         | Hue (rough)  |
|--------------|--------------|
| Company      | cornflower blue (250) |
| Organization | indigo (280) |
| Person       | leaf green (148) |
| Market       | warm gold (68) |
| Technology   | soft purple (308) |
| Product      | muted coral (12) |
| Event        | amber (88) |
| Location     | teal (190) |
| Regulation   | muted orange (38) |
| Document     | sky blue (222) |
| Concept / Topic / Entity | neutral slate (258) — also the fallback |

Selection / hover / focus state borders/glows come from CSS custom props in `styles.css` (`--kg-glow-root`, `--kg-dot-topic`, etc.) layered with `typeStyles`.

## AnimatedBlob / LoadingBlob (AnimatedBlob.tsx)
- Both render a `w-72 h-72` centered shape with two layered divs
- Outer layer: `opacity: 0.85`, `blur(6px)` — clearly visible, not a tint
- Inner layer: `opacity: 0.6`, `blur(2px)`, reversed gradient for depth
- Text is white with `textShadow` for legibility on the colored blob
- `LoadingBlob` matches `AnimatedBlob` exactly; do NOT use large blur or low opacity

## Design tokens (styles.css)
- Blob: `--kg-blob-1`, `--kg-blob-2`
- Nodes: `--kg-node-bg`, `--kg-node-border`, `--kg-node-active`, `--kg-node-hover`
- Canvas: `--kg-canvas`
- Shadows: `--kg-shadow-sm`, `--kg-shadow-md`
- Animations: `blob-morph` (6s), `blob-pulse` (4s), `node-breathe`

## API (src/lib/api.ts)
```
API_BASE = VITE_API_BASE_URL ?? 'http://localhost:8787'

createRun(prompt)                    → POST /runs → runId
openRunStream(runId)                 → EventSource /runs/:runId/events
extractFromText(runId, text, name)   → POST /ai/runs/:runId/extract
expandSubtree(runId, root, nodes, edges, question) → POST /ai/runs/:runId/expand-subtree
checkAIStatus()                      → GET /ai/status
saveOpenAIKey(key)                   → POST /ai/key
```

## Routing
Single route at `/` → `<KnowledgeGraphCanvas>`. Adding routes: create `src/routes/name.tsx` with `createFileRoute('/name')` — router plugin auto-regenerates `routeTree.gen.ts`.

## Commands
```
bun install
bun run dev          # Vite dev server
bun run build        # Production build
bunx tsc --noEmit    # Type-check only (no `typecheck` script in package.json)
```

## Do not touch
- `src/routeTree.gen.ts` — auto-generated
- `src/components/ui/` — shadcn components, add via CLI only
