# KnowledgeSwarm Remaining Tasks

Direction: build a progressive business knowledge map.

```text
Company / main entity
  -> business categories
    -> documents
      -> important facts, entities, relationships
        -> cross-links to other documents/entities
```

Completed items have been removed from this list. Already done: real category/document scaffold emission, basic category/document metadata, frontend preference for real category/document nodes, presentation graph extraction into `presentationGraph.ts`, branch-by-branch graph streaming, main-entity tagging so documents/categories never become the auto-center, MAX_LEVEL_1_NODES cap with "Other Areas" overflow grouping, hidden-neighbor badge fix on the active center, branch-growth entry animations (tiered animDelay for fresh nodes/edges), explicit ViewMode dispatch in `buildPresentationView` (hub / category / document / entity / overview), explicit MainEntityAgent step (`apps/orchestrator/src/agents/mainEntity.ts` — heuristic detection, locked-in once per run, document-name fallback for zero-extraction case, emits `main_entity.start` / `main_entity.selected` / `main_entity.fallback` agent events), `GET /runs/:runId/graph` snapshot endpoint (`apps/api/src/routes/runs.ts` + `loadRunGraph` in `apps/api/src/services/graph.ts` — returns nodes, edges, and sources joined through `edge_sources`; 503 when Supabase unconfigured, 404 when run missing), `DocumentClassifierAgent` (`apps/orchestrator/src/agents/classifier.ts`) — runs in parallel with `decomposeDocument`, returns `{ primaryCategory, secondaryCategories, reason, confidence, source }`, validated against shared `CATEGORY_KEYS` enum (`apps/orchestrator/src/ingest/categories.ts`); presentation builder honours the primary category instead of keyword `dominantCategory`, emits secondary `contains_document` edges at lower confidence, and records `secondaryCategories` + `categorySource` on document nodes; emits `classifier.start` / `classifier.classified` agent events with model→heuristic fallback. Expansion cross-connections (`apps/api/src/services/ai.ts → expandSubtree`) — Pass 2 routing schema now accepts optional `additional` connections per item (max 2, must be a different existing parent than primary); Pass 1 prompt nudges the model to prefer items that link to multiple existing nodes; cross-link triples are emitted alongside the primary parent edge so expansion no longer produces isolated leaves when the research clearly connects an item to additional graph nodes. Specialist output contract (`apps/orchestrator/src/agents/worker.ts`) — worker SYSTEM_PROMPT now requires `properties.category` (validated against shared `CATEGORY_KEYS`) and `properties.importance` (0.0-1.0 with calibrated guidance: 0.85+ headline facts, 0.6-0.85 context, <0.6 trivia); `sources[0].snippet` made required (verbatim quote, max ~280 chars); user message now includes a `Default category for this branch` hint mapped from specialist kind via `specialistKindToCategoryKey`; `presentation.ts → coerceTripleCategory` validates worker-emitted categories and `inferCategory`/`annotateTriplesForPresentation` resolution order is now `worker > document-classifier > keyword-inference`. Richer expansion context retrieval (`frontend/src/components/knowledge-graph/KnowledgeGraphCanvas.tsx → handleNodeAction`) — frontend builds a focused-context bundle for `apiExpandSubtree`: subtree + ancestors + main entity + same-category siblings (top 12 by importance) + same-document siblings (top 12) + globally top-importance nodes (top 8); for graphs ≤ 150 nodes the whole graph is sent. `contextEdges` now spans any edge between two bundle members (not only subtree+ancestor edges), giving Pass 2's routing prompt enough sibling/cross-document candidates to propose `additional` parent connections. Presentation scaffold dedupe (R4) — deleted `apps/api/src/services/presentation.ts`; the orchestrator (`apps/orchestrator/src/ingest/presentation.ts`) is now the single source of truth for main-entity / category / document scaffold emission. The legacy `/ai/runs/:runId/extract` heuristic fallback now persists raw triples only — frontend's `presentationGraph.ts` synthesises a hub view from raw triples when scaffold is absent. Frontend CLAUDE.md refresh (R5) — node sizing table now matches `graphTypes.ts → nodeDims` (root 210×76, topic 175×62, subtopic 130×46, detail 110×40 with explicit dot sizes); entity colour section replaced with the actual OKLCH palette (12 entity types each with dot/glow/tint/text variants, fallback `Concept` slate, substring matching) instead of the stale 4-colour list. Category-aware connectivity repair (Task 13) — `apps/orchestrator/src/agents/graphRepair.ts` AI prompt now ranks predicates: `document → mentions → entity` first, then `category → contains_document → document`, `main_entity → has_business_area → category`, `entity → belongs_to → category`, then concrete domain predicates, with `related_to` as last resort. Deterministic fallback also rewritten: `collectScaffoldNodes` indexes scaffold nodes by `presentationRole`, then `scaffoldBridgeForComponent` routes each orphan via document → category → main_entity in that order before falling back to the legacy `co_mentioned_with`. Bridge triples carry `scaffoldRoute` provenance for audit. Specialist routing by document category (Task 10b) — `apps/orchestrator/src/agents/specialists.ts → decideSpecialistRouting` filters specialists by the classifier's primary + secondary categories using a `CATEGORY_TO_SPECIALISTS` mapping (e.g. `finance → [finance, risk, general]`); `general` is in every set so the catch-all extractor always runs. Conservative gating: when classifier confidence is below 0.6, when `primaryCategory === 'other'`, or when filtering would drop everything, all specialists run as a fallback. `apps/orchestrator/src/index.ts` applies the routing right after `specialistForBranch` mapping; `MetaAgent` emits a `routing` agent event with kept/skipped specialists and routing source (`classifier` / `low-confidence` / `category-other` / `low-confidence-fallback`) for observability.

## Scalable Hierarchy (active — 2026-05-04)

The graph is currently locked at exactly 3 levels: `main_entity → category → entity`. This works for 3-file demos but doesn't scale: a Fortune-500 dropping 1000+ files would produce a Finance category with 5000 children. We need an adaptive hierarchy that grows with the data.

### Target architecture

```
Level 0: Main entity                                Acme Corp
Level 1: Top categories (fixed enum, 6)             Finance, HR, Ops, Legal, Risk, Strategy
Level 2: AI-named sub-categories (emerge bottom-up) Finance → Revenue, Costs, M&A, Risk, …
Level 3: Document clusters or hierarchical entities Revenue → Q3-2025 Report, …
                                                    or: Acme → owns → Beta → owns → Gamma
Level 4+: Leaf entities                             People, dates, amounts, …
```

Three mechanisms make it scale: (a) hierarchical predicates become real tree edges so ownership/management chains preserve depth, (b) AI sub-categorization runs when any node exceeds ~25 children, (c) progressive disclosure caps rendered children per parent and groups overflow into expandable buckets.

### Phase 1 — Hierarchical predicates as tree edges  ✓ (2026-05-04)

- [x] `HIERARCHICAL_PREDICATES` set in `apps/orchestrator/src/ingest/presentation.ts` covering `owns, contains, subsidiary_of, parent_of, part_of, manages, oversees, leads, reports_to, has_subsidiary, has_division, comprises, includes`
- [x] `buildHierarchicalParentMap` scans extracted triples, picks highest-confidence parent per child, handles inverse predicates (`subsidiary_of` etc. invert direction), breaks cycles by walking proposed parent chain
- [x] When emitting Layer 2, entities with a hierarchical parent get `parent_entity → contains → entity`; others fall back to `category → contains → entity`. Triples carry `containsRole: 'hierarchical' | 'category'` and the original `hierarchicalPredicate` for evidence display
- [x] Skip hierarchical parent if it equals the main entity (don't bypass the category layer for top-level entities)
- [x] Skip hierarchical parent if it's not in the known entity set (orphan-parent guard)
- [x] Frontend: no changes — BFS already follows whatever `contains` edges exist; depth 3+ renders for free
- [ ] Verify with a deeply-nested example (e.g. holding company with subsidiaries) that depths 3, 4, 5 render correctly  ← needs live test

### Phase 2 — Adaptive sub-categorization  ✓ (2026-05-04)

- [x] New orchestrator agent `apps/orchestrator/src/agents/subCategorizer.ts` (Claude Haiku via `supervisorModel`), with stub-mode + on-failure heuristic fallback that groups by entity type
- [x] `splitOversizedSubtrees(runId, presentationTriples)` in `presentation.ts` — walks every `contains` parent, calls `subCategorize` for any with > 18 children, replaces original edges with `parent → contains → subcategory` + `subcategory → contains → child` at confidence 0.93/0.92 so the frontend dedupe-by-target prefers the deeper route
- [x] Recursion up to `SUBCATEGORY_MAX_DEPTH = 3` so subcategories that themselves grow large get split again
- [x] Wired into `apps/orchestrator/src/index.ts` final pass only — incremental SSE keeps the cheap flat scaffold; subcategory layer arrives at run completion
- [x] Subcategory triples carry `subcategoryRoute: true` so the orchestrator's per-entity contains lock allows them to override earlier `category → contains → entity` edges
- [x] Frontend recognises subcategory nodes (`presentationRole: 'subcategory'`) — `isSubcategoryNode`, structural styling (slate-550 between category and bucket shades), reveal-mode treatment, and `isStructuralNode` includes them so edge scoring stays sensible

### Phase 3 — Progressive disclosure

- [ ] Frontend: per-parent visible-child cap (default 12)
- [ ] When a parent has > cap children, render the top-N by importance + an "expand" bucket (`+47 more`) for the rest
- [ ] Click bucket → expand its children, collapse other open buckets in the same parent (only one expanded at a time per parent to keep the tree breathable)
- [ ] Animate camera to focus on the expanded subtree
- [ ] All graph data stays in the underlying graph — only rendering is gated
- [ ] Existing `bucketCentralFanout` is the starting point; generalize from "only at root" to "at any parent"

### Phase 4 — Document clusters (optional, later)

- [ ] Re-introduce documents as a layer, but only when there are > 5 docs in the same subcategory
- [ ] AI clusters related docs by topic: `Q1-Q4 2025 Revenue Reports` instead of 4 separate nodes
- [ ] Documents become an optional intermediate layer between subcategory and entity, only when useful
- [ ] Cluster node click expands to individual document nodes
- [ ] Document nodes still don't appear when there are < 5 docs (current behavior preserved for small uploads)

### Why this order

Phase 1 is small but immediately turns the graph from "always 3 levels" to "as deep as your data is". Phase 2 makes it scale-ready without UI changes. Phase 3 is the unlock for actual 10K-node graphs. Phase 4 is a nice-to-have once the rest is stable.

## UX Redesign — Graph Canvas (next up)

User feedback after live demo (2026-05-03). Address in roughly this order — items higher up are higher impact / more painful right now.

### Status of the in-flight redesign

Already shipped from this redesign cycle:

- [x] uniform-sector radial layout: Acme Corp dead-centre, depth-1 children evenly spaced around the full circle (no longer bottom-heavy from subtree-size weighting)
- [x] sector inheritance at deeper levels so subtrees can't cross into a sibling's angular slice
- [x] auto-fit: 1.2s after the last node-count change, Sigma re-runs `animatedReset`
- [x] reserve 120px bottom padding on the Sigma container so auto-fit clears the floating query bar
- [x] zoom controls hidden on the empty/landing state
- [x] overview button removed from `TopNav` (fit-graph in the bottom-right zoom stack covers this)
- [x] loading indicator persists until handleDataSubmit / handleUploadDocuments's await chain settles (the per-file MetaAgent `completed` event was firing too early in multi-file uploads)
- [x] labels: depth ≤ 1 forced when totalNodes ≤ 200; deeper nodes defer to Sigma's `labelDensity` collision avoidance; `LABEL_MAX_CHARS=24` truncation
- [x] QueryBox compact (no chips by default; chips reveal on input focus or scoped answer)

### Known backend bugs (not part of UI redesign — fix later)

- **Duplicate near-identical entity nodes** — the orchestrator's normalizer is emitting separate nodes for label variants that should collapse to one (e.g. `Beta Storage acquisition` vs `Beta Storage Acquisition`, `lithium volatility` vs `Lithium Volatility`). Symptom: in the graph the same concept shows up twice, each with its own subset of edges, so neither variant looks fully connected. Fix candidates: (a) case-fold + whitespace-normalize labels before deduping in `apps/orchestrator/src/ingest/normalizer.ts`, (b) add a fuzzy-match pass that merges very-close labels (`Levenshtein ≤ 2` or normalized-Jaro-Winkler) when their entity types match. Keep one canonical label per merged group.

### Next up — concrete items (priority order)

1. **Active-centre distinct treatment** — the active root currently renders as a near-black filled dot that visually competes with depth-1 colored siblings. Give it a clear ring/glow/outline so it reads as the focal point at first glance. File: `SigmaGraphView.tsx → nodeColor` / `nodeSize` / Sigma node attributes.
2. **Monochrome / desaturated palette experiment** — replace the current saturated entity-type colors with a single brand color stepped by role/depth. Reintroduce semantic color only with an explicit legend if navigation needs it. File: `SigmaGraphView.tsx → nodeColor` (and the per-type branches inside).
3. **Initial growth animation** — sequence: center → neighbors fade-in → edges draw → recurse. Today new nodes appear with their parent edges already attached, and existing nodes re-position when batches commit. Approach: keep `animDelay` per-node (already wired by `assignAnimDelays` in `useGraphSSE.ts`), but make Sigma honor it by tweening node opacity and fading edges in *after* both endpoint nodes are visible. Also lock node positions once they've been visible for >N ms so they don't snap during late commits.
4. **Edge styling by role** — vary stroke weight + opacity. Primary triple edges full weight; scaffold/expand-bridge edges thinner + lower opacity; low-confidence edges fade further. File: `SigmaGraphView.tsx → edgeAttributes`.
5. **Subtree crowding at depth 2/3** — when a depth-1 node owns a much bigger subtree than its angular slice (e.g. `Documents` with 5 CSV files × N entities), descendants pack into a tight arc and overlap. Options to explore (pick one): (a) push children onto multiple concentric sub-rings inside the parent's slice, (b) extend `bucketCentralFanout` to apply at deeper levels, (c) make ring radius per-subtree scale with sqrt(subtree size) so a fat subtree gets pushed further out.
6. **Radial label offsets** — labels currently render to the right of every dot, so a node at the left edge has its label running back into the graph. Set Sigma's `labelOffsetX/Y` per node based on the node's angle from origin (outward-pointing offset). File: `SigmaGraphView.tsx → nodeAttributes`.
7. **Hide zoom-control "fit graph" button** if it overlaps the auto-fit work (decide once #1–#6 are stable; auto-fit may make the manual button redundant for everyday use).

### Shape & layout

- the graph is not a mindmap right now. The desired shape is a **clean circular mindmap with one center point**, with branches radiating evenly around the center. Today the graph is bottom-heavy, off-axis, and crowded around a secondary hub. Constrain the layout so the active root sits dead-center and branches fan out in every direction (top, left, right, bottom) with comparable angular density.
- top half of the canvas is empty while the bottom is jammed. Layout must distribute around the full canvas, not collapse downward.

### Initial growth animation

- the first-paint growth currently looks bad: ~6 nodes pop in already-connected, then more nodes appear and the originals get repositioned. There is no sense of "the graph grew."
- desired sequence:
  1. one center dot appears
  2. the immediate neighbors slowly fade/scale in around it (no edges yet)
  3. edges then draw out from the center to each neighbor (animated stroke or line-grow)
  4. each neighbor's children then appear around it, edges then draw — recursively
- repositioning of already-painted nodes during streaming should be minimized. If a node has been visible for >N ms, its position should be sticky.

### Color & labels

- current entity-type color palette is not pleasant ("not nice to the eye"). Since the colors are not legible to a first-time user (no legend, no labels), **try a desaturated/monochrome palette** (single brand color with depth/role variations) and see if it feels cleaner. Re-introduce semantic color only if needed for navigation, and only with an obvious legend.
- almost no nodes have visible labels right now — only the active center. Every node must have a readable label by default, with label-density throttled to zoom level (small/abbreviated when zoomed out, full when zoomed in).

### Controls / chrome

- the zoom controls (`+ / − / fit`) currently render on the empty/landing screen. They should only appear when a graph is loaded.
- the **overview button (TopNav, 4-circle icon)** and the **fit-graph button (bottom-right zoom controls)** appear to overlap in purpose — decide which one stays. Likely keep "fit graph" only and drop the overview toggle (or repurpose overview to mean something distinct, e.g. "show all nodes ignoring active-node neighborhood").
- the action-chip row at the bottom (`Find connections / Find risks / Summarize branch / Compare docs / Key people / Financial signals / Legal obligations`) and the "Ask anything about your data…" query box currently sit on top of graph nodes. Move them out of the canvas area or collapse them into a non-occluding bottom bar.

### Loading indicator

- the loading affordance disappears too early. It should remain visible **until the entire AI extraction run is fully done** (all branches finished, all triples emitted, all categorization passes complete) — not just until the first nodes are committed. Tie its visibility to a real "run complete" signal from the orchestrator/SSE stream.

### Active-center styling

- the active "Acme Corp" center node looks weaker than its colored children — solid near-black fill with a thin white ring. Use a distinct ring/glow treatment so the active center is unambiguously the focal point, not just another dot.

### Edge styling

- all edges are currently the same weight/color, producing edge spaghetti at scale. Vary thickness/opacity by edge role: primary triple edges get full weight, scaffold/expand-bridge edges get thinner and lower-opacity, low-confidence edges fade further.

## Frontend Regression Checks

Keep these covered while refactoring the presentation graph:

- uploaded/added documents must never become the automatic central hub node
- level-1 hub fanout must stay capped; overflow should be grouped into broader/general nodes such as "Other Areas"
- dense focused nodes with more than 8 renderable neighbors should show meaningful category buckets around the center, not a generic "More Connections" folder
- clicking a connected entity should make that entity the center of its local neighborhood, not reuse the main hub's hidden-neighbor count
- category and document nodes can use category/document modes, but ordinary high-degree entities should not be forced into hub mode unless they are tagged `presentationRole: main_entity`
- badges must show the number of nodes that would actually become visible when clicked, not raw graph degree or hidden global neighbors
- nodes must not overlap in focused views, category-bucket views, hub views, or overview mode
- the current Sigma overview must remain the source of truth for large-graph navigation; do not reintroduce React Flow overview/minimap behavior
- uploading multiple documents must create one Document node per file; never create a single document node whose label is a comma-separated list of file names
- extracted entities such as companies should connect to meaningful graph nodes/categories/main entity as well as source documents; document-only attachment is not enough
- every visible node must have a visible line explaining why it is shown; no orphan-looking nodes around a center
- if a node says it has subnodes, clicking it must reveal those exact category/member nodes, not only source-document links
- dense-neighbor category buckets should be expandable into their member nodes and preserve real relationships where possible

## Refactor / Cleanup Tasks

### R0. Long-Term Graph Renderer Shift

Current direction: the main graph canvas should move away from DOM-heavy React Flow rendering and toward a real graph renderer.

Initial implementation status:

- `sigma`, `graphology`, and `graphology-layout-forceatlas2` are installed in the frontend.
- `SigmaGraphView.tsx` renders the current focused presentation graph as simple circular nodes with straight edges.
- `KnowledgeGraphCanvas.tsx` now uses Sigma for the main canvas.
- first graph creation now inserts a provisional central node immediately after `/runs` succeeds, so the loading state can clear into a visible center before the swarm finishes.
- the initial blob now clears as soon as that provisional center is visible; extraction can continue streaming in the background.
- Sigma now keeps one persistent Graphology instance and updates nodes/edges in place.
- Sigma uses `animDelay` to stage new node/edge insertion, giving branch-growth behavior as SSE data streams in.
- Sigma now has a branch-preserving layout: center -> category spokes -> document/entity/fact branches.
- Sigma camera stays stable during streaming updates and only resets on first graph load, active-node changes, or explicit fit.
- Sigma has zoom in / zoom out / fit controls.
- Active, highlighted, document, category, and ordinary entity nodes have distinct visual treatment.
- React Flow `fitBounds` / `fitView` calls and provider hooks have been removed from the active canvas.
- `KnowledgeGraphRenderer.tsx` now owns the Sigma rendering boundary; `KnowledgeGraphCanvas.tsx` no longer imports renderer primitives directly.
- Sigma now always receives raw graph nodes/edges and shows the whole graph. The smaller click-through presentation graph is retained only for metadata/panel lookups while cleanup continues.
- Sigma overview mode now uses smaller nodes, lower label density, muted edges, no staged insertion delay, and a prioritized edge cap for very dense graphs.
- Sigma edge clicks now open an evidence panel with source/target, predicate, confidence, source label, snippets, and clickable web source links when available.
- Sigma nodes and edges now show pointer cursor feedback on hover.
- Sigma edge hover now visually highlights the edge before click so source/evidence inspection is easier.
- Sigma now caps direct center fanout without dropping graph data: overflow center neighbors are routed through semantic bucket nodes such as Finance, Legal & Compliance, People & HR, Operations, Documents, and Other Areas.
- Sigma edge evidence now resolves local document sources back to their Document nodes when possible, so source labels can be clicked to open the document panel.
- Sigma semantic bucket nodes are now interactive: clicking a bucket highlights its grouped member nodes instead of doing nothing.
- Sigma bucket interactions now fit the camera to the member cluster and show a compact member list panel with click-through to individual nodes.
- Sigma evidence now handles edges with many sources by showing the first three and offering a show-more toggle instead of silently truncating snippets.
- Sigma branch layout now allocates wider angular sectors to larger subtrees and gives crowded child branches more local fan space.
- Sigma camera reset behavior now keys off first load / actual center changes, so clicking ordinary nodes does not snap the whole graph back to origin.
- Sigma overview label density, label threshold, and edge cap now scale down as graph size grows, keeping large runs lighter without changing stored graph data.
- Sigma evidence now shows stronger provenance metadata from edge properties: extracting agent, category, importance, repair/scaffold/inferred tags, and source kind badges.
- Sigma evidence now has a copy action that exports the relationship, confidence, agent/category/importance/provenance, source URLs, and snippets as plain text.
- Renamed the frontend app directory from the Lovable-generated `insight-bloom-651-main` to `frontend`, and updated repo docs/package metadata to match.
- Removed the inactive React Flow minimap and viewport tracking from `KnowledgeGraphCanvas`; Sigma owns whole-graph navigation now.
- Removed the React Flow renderer fallback from `KnowledgeGraphRenderer` and dropped the React Flow provider/camera hooks from `KnowledgeGraphCanvas`; the canvas is now Sigma-only and uses local `GraphNode` / `GraphEdge` types.
- Initial multi-file drag/drop and MCP import now preserve per-file document identity by extracting each file sequentially against the same run instead of sending one comma-separated `documentName`.
- the streaming progress affordance now shows the latest swarm phase, active branch, node/edge counts, recent triple count, and source count instead of a generic "Adding to graph" label.
- React Flow dependency cleanup is complete: frontend graph state now uses local `GraphNode` / `GraphEdge` types in `graphTypes.ts`, the old React Flow node/edge components were removed, and `@xyflow/react` was uninstalled.
- Sigma readability pass: crowded branch sectors now get more angular spread and distance, node position updates tween in a single batched animation for graphs up to 500 visible nodes, and old React Flow CSS/doc references were cleaned up.
- UI graph polish pass: Sigma now uses a desaturated/monochrome role palette, edge thickness/opacity varies by role and confidence, zoom/evidence controls are lifted above the query dock, the query shortcuts collapse into a non-occluding bottom dock, the extraction progress pill sits under the top nav instead of over the graph controls, and filters now include entity type/source kind in addition to category/document/importance.
- Sigma evidence/detail pass: relationship evidence now has clearer source preview cards with scrollable snippets and document click-through, plus copy/export actions for plain text, Markdown, and JSON. Sigma also has renderer-local level-of-detail controls (`essential` / `balanced` / `full`) so large graphs can stay navigable without deleting stored graph data.
- Growth/active-center polish: SSE animation delays now guarantee nodes appear before their edges, visible nodes become position-sticky after a short settling window to reduce streaming jitter, and the active center gets a renderer-local halo so the focal node reads clearly. Source-kind filters now inspect incident edge evidence instead of only node metadata, so web/document/local filtering reflects actual provenance.

Immediate implementation checklist:

- [ ] validate Sigma whole-graph branch spacing with real demo screenshots and adjust constants if screenshots show clutter
- [ ] dense-graph UX polish: validate level-of-detail thresholds with real large documents and adjust `essential` / `balanced` caps if needed

### R1. Decompose KnowledgeGraphCanvas.tsx

`frontend/src/components/knowledge-graph/KnowledgeGraphCanvas.tsx` was past 2000 lines and concentrated too many concerns. Extracted so far:

```text
src/components/knowledge-graph/layout.ts          # done: forceDirectedLayout + resolveOverlaps + helpers
src/components/knowledge-graph/useGraphSSE.ts     # done: node/edge/source/agent.step SSE handlers + pending buffers + layout-debounce commit
src/components/knowledge-graph/useExpansion.ts    # done: handleNodeAction — context bundle, expansion queue, anchor management
```

Canvas is now ~1200 lines (from ~1900). Remaining concerns still concentrated in the canvas: drag/drop file upload pipeline, query mode (`handleQuery`), search/side-panel state glue, undo/redo history, node-click → side-panel routing. Pull these out only if a concrete need (e.g. test isolation, reuse) shows up — otherwise the file is now small enough to navigate.

Goal: each module should fit in one screen and have a single responsibility.

## Optional / Longer-Term Tasks

### 18. Sigma.js Whole Mindmap Navigation

The main canvas now uses Sigma.js for the whole mindmap. Keep improving this path instead of rebuilding large-graph behavior in React Flow.

Goal:

```text
Sigma.js = fast whole-graph exploration
Panels = rich node/document/evidence details
```

Expected behavior:

- the whole graph remains available in Sigma, not hidden behind old click-through views
- direct spokes around the center stay capped with semantic buckets for overflow
- categories/documents/entities have clear visual distinctions
- clicking a node opens the appropriate node/document panel
- edge clicks expose evidence and source snippets
- zoom/pan remains fast for large graphs

Implementation notes:

- use all raw `nodes` and `edges` for Sigma
- React Flow is no longer a renderer fallback and `@xyflow/react` has been removed from the frontend.
- keep bucket nodes renderer-local unless they become real user-facing category summaries

### 19. Optional Graph Analytics

Use case:

```text
thousands of nodes
search across all graph data
community detection
global relationship exploration
```

Add graph algorithms/community detection only after the core Sigma renderer feels stable.

### 20. Better Search And Filtering

Add filters:

```text
category
document
entity type
agent
importance
confidence
source
date
```

### 21. Timeline View

For business data, add a timeline mode:

```text
contracts signed
revenue periods
shipments
employee changes
funding events
risks over time
```

### 22. Evidence Mode

Allow users to inspect why a node or edge exists:

```text
source snippets
document path
agent that extracted it
confidence
inferred vs explicit
timestamp
```

### 23. Human Review / Approval

For serious use, add review state:

```text
pending
approved
rejected
needs evidence
```

### 24. Better MCP Productization

Improve downloadable connector:

```text
one-click local connector
folder picker
health indicator
file allowlist
clear privacy explanation
```

### 25. Multi-Run Projects

Allow a project to contain multiple runs:

```text
run 1: initial upload
run 2: added contract folder
run 3: web research expansion
```

Merge into one project graph with provenance.

## Suggested Implementation Order

1. R0: Stabilize the Sigma main renderer and progressive branch growth.
2. R1: Decompose KnowledgeGraphCanvas.tsx (>2000 lines).
3. Replace minimap with Sigma.js whole-mindmap map (Task 18), or remove it if the main Sigma canvas fully covers this need.
