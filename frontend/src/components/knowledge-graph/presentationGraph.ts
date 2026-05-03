import type { GraphEdge, GraphNode, GraphNodeData } from './graphTypes';

const PRESENTATION_PREFIX = 'presentation:';

// Hard cap on level-1 fanout. Beyond this, the hub view groups overflow into a
// single "Other Areas" aggregator so the central node stays visually readable.
const MAX_LEVEL_1_NODES = 8;
const MAX_FOCUSED_LEVEL_1_NODES = 8;

// How many neighbors of a node are NOT currently rendered. Used as the "+N"
// badge so the user can see where more graph hangs off this point. Counts only
// edges that lead OUT of the visible set — when a node is the active center
// and all its 1-hop neighbors are visible, the badge correctly drops to 0.
function hiddenNeighborCount(nodeId: string, visibleIds: Set<string>, edgeList: GraphEdge[]): number {
  let count = 0;
  for (const edge of edgeList) {
    if (edge.source === nodeId) {
      if (!visibleIds.has(edge.target)) count++;
    } else if (edge.target === nodeId) {
      if (!visibleIds.has(edge.source)) count++;
    }
  }
  return count;
}

const businessCategories = [
  {
    key: 'finance',
    label: 'Finance',
    keywords: ['finance', 'financial', 'revenue', 'cost', 'margin', 'valuation', 'investor', 'funding', 'payment', 'fee', 'debt', 'profit', 'budget'],
  },
  {
    key: 'hr',
    label: 'HR & People',
    keywords: ['person', 'employee', 'team', 'role', 'hr', 'people', 'salary', 'compensation', 'manager', 'reports', 'leadership', 'contractor'],
  },
  {
    key: 'legal',
    label: 'Legal',
    keywords: ['legal', 'contract', 'agreement', 'patent', 'license', 'compliance', 'regulation', 'jurisdiction', 'obligation', 'confidentiality', 'termination'],
  },
  {
    key: 'operations',
    label: 'Operations',
    keywords: ['operation', 'warehouse', 'order', 'shipment', 'logistics', 'inventory', 'supplier', 'supply', 'facility', 'manufacturing', 'delivery'],
  },
  {
    key: 'strategy',
    label: 'Strategy & Market',
    keywords: ['market', 'customer', 'competitor', 'partner', 'partnership', 'industry', 'geography', 'growth', 'positioning', 'acquisition'],
  },
  {
    key: 'technology',
    label: 'Technology',
    keywords: ['technology', 'system', 'software', 'api', 'database', 'security', 'product', 'platform', 'integration', 'infrastructure'],
  },
] as const;

type BusinessCategoryKey = typeof businessCategories[number]['key'] | 'documents' | 'other';

interface PresentationSource {
  url: string;
  title?: string;
  snippet?: string;
}

interface DocumentContext {
  id: string;
  key: string;
  title: string;
  snippets: string[];
  nodeIds: Set<string>;
  edgeIds: Set<string>;
}

type PresentationRole = 'center' | 'topic' | 'subtopic' | 'detail';

interface HubBucket {
  key: string;
  label: string;
  count: number;
  memberIds: string[];
  sourceNode?: GraphNode;
}

interface HubFanoutResult {
  kept: HubBucket[];
  overflowNode: GraphNode | null;
}

interface FocusedNeighborViewArgs {
  centerNode: GraphNode;
  directEdges: GraphEdge[];
  realNodesById: Map<string, GraphNode>;
  graphEdges: GraphEdge[];
  highlightedNodes: Set<string>;
  neighborRole: (node: GraphNode) => PresentationRole;
}

export function isPresentationNodeId(id: string | null | undefined): boolean {
  return Boolean(id?.startsWith(PRESENTATION_PREFIX));
}

export function isRealCategoryNode(node: GraphNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as GraphNodeData;
  return data.description === 'Category' || data.presentationRole === 'business_area';
}

export function isRealDocumentNode(node: GraphNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as GraphNodeData;
  return data.description === 'Document' || data.presentationRole === 'document';
}

export function isMainEntityNode(node: GraphNode | undefined): boolean {
  if (!node) return false;
  const data = node.data as GraphNodeData;
  return data.presentationRole === 'main_entity';
}

// Pick the best initial center for the hub view. Prefer (in order):
//   1. an explicit main_entity (orchestrator-tagged)
//   2. the most-connected non-document, non-category node
//   3. the most-connected node of any kind
//   4. the first node available
// Documents and categories are scaffold structure and should never auto-focus
// as the central node — that demotes the actual subject of the graph.
export function chooseInitialCenter(graphNodes: GraphNode[], graphEdges: GraphEdge[]): GraphNode | null {
  if (graphNodes.length === 0) return null;
  const main = graphNodes.find(isMainEntityNode);
  if (main) return main;

  const isStructural = (node: GraphNode) => isRealDocumentNode(node) || isRealCategoryNode(node);
  const entities = graphNodes.filter(node => !isStructural(node));
  const pool = entities.length > 0 ? entities : graphNodes;
  const ids = new Set(pool.map(node => node.id));
  const best = mostConnectedNodeId(ids, graphEdges);
  return (best ? pool.find(node => node.id === best) : null) ?? pool[0] ?? null;
}

// Explicit view modes — drive the buildPresentationView dispatch and document
// what the user sees in each. Avoid showing the entire graph by default; the
// only mode that does so is 'overview', triggered by showAllNodes.
//
//   hub      — main entity at center, business categories radiating around it
//   category — category at center with its documents and top entities
//   document — document at center with the entities it mentions
//   entity   — entity at center with its 1-hop neighborhood
//   overview — full graph, used for search results and explicit "see all"
//
export type ViewMode = 'hub' | 'category' | 'document' | 'entity' | 'overview';

function classifyViewMode(args: {
  activeNodeId: string | null;
  showAllNodes: boolean;
  activeRealNode: GraphNode | null | undefined;
  centerNode: GraphNode;
  graphEdges: GraphEdge[];
}): ViewMode {
  if (args.showAllNodes) return 'overview';
  const id = args.activeNodeId;
  if (id?.startsWith(`${PRESENTATION_PREFIX}category:`)) return 'category';
  if (id?.startsWith(`${PRESENTATION_PREFIX}document:`)) return 'document';
  if (args.activeRealNode) {
    if (isRealCategoryNode(args.activeRealNode)) return 'category';
    if (isRealDocumentNode(args.activeRealNode)) return 'document';
    if (isMainEntityNode(args.activeRealNode)) return 'hub';
  }
  // No active node, or active node not in the live graph yet → start at the hub.
  if (!id || !args.activeRealNode) return 'hub';
  // Clicking an ordinary entity should focus that entity's local neighborhood.
  // Do not promote high-degree/company-like nodes into hub mode unless the
  // orchestrator explicitly tagged them as the main entity above.
  return 'entity';
}

export function mostConnectedNodeId(nodeIds: Set<string>, edgeList: GraphEdge[]): string | null {
  let bestId: string | null = null;
  let bestDegree = -1;

  for (const id of nodeIds) {
    let degree = 0;
    for (const edge of edgeList) {
      if (edge.source === id && nodeIds.has(edge.target)) degree++;
      if (edge.target === id && nodeIds.has(edge.source)) degree++;
    }
    if (degree > bestDegree) {
      bestDegree = degree;
      bestId = id;
    }
  }

  return bestId;
}

function roleNodeType(role: PresentationRole): GraphNodeData['nodeType'] {
  if (role === 'center') return 'root';
  if (role === 'topic') return 'topic';
  if (role === 'subtopic') return 'subtopic';
  return 'detail';
}

function promoteNodeForView(
  node: GraphNode,
  role: PresentationRole,
  extra: Record<string, unknown> = {},
): GraphNode {
  return {
    ...node,
    data: {
      ...node.data,
      nodeType: roleNodeType(role),
      ...extra,
    },
  };
}

function applyHubFanoutCap(buckets: HubBucket[]): HubFanoutResult {
  const sorted = [...buckets].sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  const kept = sorted.slice(0, MAX_LEVEL_1_NODES);
  const overflow = sorted.slice(MAX_LEVEL_1_NODES);
  const overflowNode = overflow.length > 0
    ? makePresentationNode(
        categoryNodeId('overflow'),
        'Other Areas',
        'topic',
        'Category',
        {
          categoryKey: 'other',
          hiddenCount: overflow.reduce((sum, bucket) => sum + bucket.count, 0),
          memberIds: overflow.flatMap(bucket => bucket.memberIds),
          overview: `${overflow.length} additional area${overflow.length === 1 ? '' : 's'}: ${overflow.slice(0, 5).map(bucket => bucket.label).join(', ')}${overflow.length > 5 ? '…' : ''}`,
        },
      )
    : null;

  return { kept, overflowNode };
}

function buildFocusedNeighborView({
  centerNode,
  directEdges,
  realNodesById,
  graphEdges,
  highlightedNodes,
  neighborRole,
}: FocusedNeighborViewArgs): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const neighborIds = new Set<string>();
  for (const edge of directEdges) {
    if (edge.source === centerNode.id && realNodesById.has(edge.target)) neighborIds.add(edge.target);
    if (edge.target === centerNode.id && realNodesById.has(edge.source)) neighborIds.add(edge.source);
  }

  const sortedNeighbors = [...neighborIds]
    .map(id => realNodesById.get(id))
    .filter((node): node is GraphNode => Boolean(node))
    .sort((a, b) => focusedNeighborScore(b, graphEdges) - focusedNeighborScore(a, graphEdges));

  if (sortedNeighbors.length > MAX_FOCUSED_LEVEL_1_NODES) {
    return buildFocusedGroupedNeighborView({
      centerNode,
      neighbors: sortedNeighbors,
      graphEdges,
      highlightedNodes,
    });
  }

  const keptNeighbors = sortedNeighbors.slice(0, MAX_FOCUSED_LEVEL_1_NODES);
  const visibleIds = new Set<string>([centerNode.id, ...keptNeighbors.map(node => node.id)]);
  const visibleEdges = directEdges.filter(edge => visibleIds.has(edge.source) && visibleIds.has(edge.target));

  const center = promoteNodeForView(centerNode, 'center', {
    hiddenCount: hiddenNeighborCount(centerNode.id, visibleIds, graphEdges),
    isHighlighted: highlightedNodes.has(centerNode.id),
  });
  const nodes = [
    center,
    ...keptNeighbors.map(node => promoteNodeForView(node, neighborRole(node), {
      hiddenCount: hiddenNeighborCount(node.id, visibleIds, graphEdges),
      isHighlighted: highlightedNodes.has(node.id),
    })),
  ];
  const edges = visibleEdges;

  return {
    nodes: layoutVisibleNeighborhood(nodes, edges, centerNode.id),
    edges,
  };
}

function buildFocusedGroupedNeighborView({
  centerNode,
  neighbors,
  graphEdges,
  highlightedNodes,
}: {
  centerNode: GraphNode;
  neighbors: GraphNode[];
  graphEdges: GraphEdge[];
  highlightedNodes: Set<string>;
}): { nodes: GraphNode[]; edges: GraphEdge[] } {
  const bucketsByKey = new Map<string, HubBucket>();

  for (const node of neighbors) {
    const bucket = focusedBucketForNeighbor(node, graphEdges);
    const current = bucketsByKey.get(bucket.key) ?? {
      key: bucket.key,
      label: bucket.label,
      count: 0,
      memberIds: [],
    };
    current.count += 1;
    current.memberIds.push(node.id);
    bucketsByKey.set(bucket.key, current);
  }

  const { kept, overflowNode } = applyHubFanoutCap([...bucketsByKey.values()]);
  const bucketNodes = kept.map(bucket => makePresentationNode(
    categoryNodeId(bucket.key),
    bucket.label,
    'topic',
    'Category',
    {
      categoryKey: bucket.key,
      hiddenCount: bucket.count,
      memberIds: bucket.memberIds,
      overview: `${bucket.count} related node${bucket.count === 1 ? '' : 's'} in ${bucket.label}: ${bucket.memberIds.slice(0, 6).map(id => {
        const node = neighbors.find(item => item.id === id);
        return node ? (node.data as GraphNodeData).label : id;
      }).join(', ')}${bucket.memberIds.length > 6 ? '…' : ''}`,
    },
  ));
  const center = promoteNodeForView(centerNode, 'center', {
    hiddenCount: 0,
    isHighlighted: highlightedNodes.has(centerNode.id),
  });
  const nodes = [center, ...bucketNodes, ...(overflowNode ? [overflowNode] : [])];
  const edges = nodes
    .filter(node => node.id !== centerNode.id)
    .map(node => makePresentationEdge(centerNode.id, node.id, 'groups'));

  return {
    nodes: layoutVisibleNeighborhood(nodes, edges, centerNode.id),
    edges,
  };
}

function focusedBucketForNeighbor(node: GraphNode, graphEdges: GraphEdge[]): { key: string; label: string } {
  if (isRealDocumentNode(node)) return { key: 'documents', label: 'Documents' };

  const data = node.data as GraphNodeData;
  if (typeof data.semanticCategory === 'string' && data.semanticCategory.trim()) {
    const label = data.semanticCategory.trim();
    return { key: `semantic-${slugify(label)}`, label };
  }

  const key = categorizeNode(node, incidentEdgesForNode(node.id, graphEdges));
  if (key === 'documents') return { key, label: 'Documents' };
  if (key === 'other') return { key, label: 'Other' };

  return {
    key,
    label: businessCategories.find(category => category.key === key)?.label ?? 'Other',
  };
}

function focusedNeighborScore(node: GraphNode, graphEdges: GraphEdge[]): number {
  const data = node.data as GraphNodeData;
  const importance = typeof data.importance === 'number' ? data.importance : 0;
  const structuralBonus = isRealDocumentNode(node) ? 5 : isRealCategoryNode(node) ? 4 : 0;
  return incidentEdgesForNode(node.id, graphEdges).length + importance * 10 + structuralBonus;
}

export function buildPresentationView(
  graphNodes: GraphNode[],
  graphEdges: GraphEdge[],
  activeNodeId: string | null,
  showAllNodes: boolean,
  highlightedNodes: Set<string>,
): { nodes: GraphNode[]; edges: GraphEdge[] } {
  if (graphNodes.length === 0) return { nodes: graphNodes, edges: graphEdges };

  const realNodesById = new Map(graphNodes.map(node => [node.id, node]));
  const realCategoryNodes = graphNodes.filter(isRealCategoryNode);
  const realDocumentNodes = graphNodes.filter(isRealDocumentNode);
  const realPresentationAvailable = realCategoryNodes.length > 0 || realDocumentNodes.length > 0;
  const documents = collectDocumentContexts(graphEdges);
  const activeRealNode = activeNodeId ? realNodesById.get(activeNodeId) : null;
  // The hub fallback prefers the tagged main entity, then the most-connected
  // non-document/non-category node. Without this guard, a Documents category
  // node (which links to every uploaded document) often outranked the actual
  // company and got picked as the central node.
  const fallbackCenter = chooseInitialCenter(graphNodes, graphEdges);
  const centerNode = activeRealNode ?? fallbackCenter ?? graphNodes[0];

  const viewMode = classifyViewMode({
    activeNodeId,
    showAllNodes,
    activeRealNode,
    centerNode,
    graphEdges,
  });

  // Overview mode: full graph rendered as-is. Only entered explicitly via
  // showAllNodes (e.g. search panel "see all"). All other modes are bounded.
  if (viewMode === 'overview') {
    const visibleIds = new Set(graphNodes.map(node => node.id));
    const overviewNodes = graphNodes.map(node => ({
      ...node,
      data: {
        ...node.data,
        hiddenCount: hiddenNeighborCount(node.id, visibleIds, graphEdges),
        isHighlighted: highlightedNodes.has(node.id),
      },
    }));
    return { nodes: overviewNodes, edges: graphEdges };
  }

  // ── Mode: category (real) — active node is a real category emitted by the
  // orchestrator. Show that category at center with all of its 1-hop neighbors
  // (documents and entities the orchestrator linked to it).
  if (viewMode === 'category' && activeRealNode && isRealCategoryNode(activeRealNode)) {
    const directEdges = graphEdges.filter(edge => edge.source === activeRealNode.id || edge.target === activeRealNode.id);
    return buildFocusedNeighborView({
      centerNode: activeRealNode,
      directEdges,
      realNodesById,
      graphEdges,
      highlightedNodes,
      neighborRole: node => isRealDocumentNode(node) ? 'topic' : 'subtopic',
    });
  }

  // ── Mode: document (real) — active node is a real document. Show its
  // 1-hop entity neighborhood (everything it mentions) and the categories it
  // belongs to. ──
  if (viewMode === 'document' && activeRealNode && isRealDocumentNode(activeRealNode)) {
    const directEdges = graphEdges.filter(edge => edge.source === activeRealNode.id || edge.target === activeRealNode.id);
    return buildFocusedNeighborView({
      centerNode: activeRealNode,
      directEdges,
      realNodesById,
      graphEdges,
      highlightedNodes,
      neighborRole: () => 'subtopic',
    });
  }

  // ── Mode: hub (real) — main entity (or fallback center) at the middle,
  // orchestrator-emitted category nodes radiating around it. Capped at
  // MAX_LEVEL_1_NODES with overflow rolled into "Other Areas". ──
  if (viewMode === 'hub' && realPresentationAvailable) {
    const buckets = realCategoryNodes
      .filter(node => node.id !== centerNode.id)
      .map(node => {
        const memberIds = (node.data as GraphNodeData).memberIds;
        return {
          key: node.id,
          label: (node.data as GraphNodeData).label,
          count: incidentEdgesForNode(node.id, graphEdges).length,
          memberIds: Array.isArray(memberIds) ? memberIds.filter((id): id is string => typeof id === 'string') : [node.id],
          sourceNode: node,
        };
      });
    const { kept, overflowNode } = applyHubFanoutCap(buckets);

    const hubNode = promoteNodeForView(
      centerNode,
      'center',
      {
        hiddenCount: Math.max(0, graphNodes.length - realCategoryNodes.length - 1),
        isHighlighted: highlightedNodes.has(centerNode.id),
      },
    );
    const visibleCategories = kept
      .map(bucket => bucket.sourceNode)
      .filter((node): node is GraphNode => Boolean(node))
      .map(node => promoteNodeForView(
        node,
        'topic',
        {
          hiddenCount: Math.max(0, incidentEdgesForNode(node.id, graphEdges).length - 1),
          isHighlighted: highlightedNodes.has(node.id),
        },
      ));
    const categoryIds = new Set(visibleCategories.map(node => node.id));
    const directEdges = graphEdges.filter(edge =>
      (edge.source === centerNode.id && categoryIds.has(edge.target)) ||
      (edge.target === centerNode.id && categoryIds.has(edge.source))
    );
    const directlyConnectedCategoryIds = new Set(directEdges.map(edge => edge.source === centerNode.id ? edge.target : edge.source));
    const missingCategoryEdges = visibleCategories
      .filter(node => !directlyConnectedCategoryIds.has(node.id))
      .map(node => makePresentationEdge(hubNode.id, node.id, 'branch'));
    const presentationEdges = [
      ...directEdges,
      ...missingCategoryEdges,
      ...(overflowNode ? [makePresentationEdge(hubNode.id, overflowNode.id, 'branch')] : []),
    ];
    return {
      nodes: layoutVisibleNeighborhood(
        [hubNode, ...visibleCategories, ...(overflowNode ? [overflowNode] : [])],
        presentationEdges,
        hubNode.id,
      ),
      edges: presentationEdges,
    };
  }

  // ── Mode: category (synthetic) — clicked a presentation:category:* hub.
  // Show that category's bucketed members and the documents that contributed
  // to it. ──
  if (viewMode === 'category' && activeNodeId?.startsWith(`${PRESENTATION_PREFIX}category:`)) {
    const categoryKey = activeNodeId.replace(`${PRESENTATION_PREFIX}category:`, '');
    if (categoryKey === 'documents') {
      const docs = [...documents.values()]
        .sort((a, b) => b.edgeIds.size - a.edgeIds.size)
        .slice(0, 18);
      const categoryNode = makePresentationNode(
        activeNodeId,
        'Documents',
        'root',
        'Category',
        { categoryKey, hiddenCount: Math.max(0, documents.size - docs.length) },
      );
      const docNodes = docs.map(doc => makePresentationNode(
        doc.id,
        doc.title,
        'topic',
        'Document',
        {
          documentKey: doc.key,
          documentSummary: doc.snippets.slice(0, 3).join(' '),
          hiddenCount: Math.max(0, doc.nodeIds.size),
        },
      ));
      const presentationEdges = docNodes.map(doc => makePresentationEdge(categoryNode.id, doc.id, 'contains'));
      return {
        nodes: layoutVisibleNeighborhood([categoryNode, ...docNodes], presentationEdges, categoryNode.id),
        edges: presentationEdges,
      };
    }

    const semanticLabel = categoryKey.startsWith('semantic-') ? categoryKey.replace(/^semantic-/, '') : null;
    const category = businessCategories.find(item => item.key === categoryKey);
    const members = graphNodes
      .filter(node => {
        if (semanticLabel) {
          const value = (node.data as GraphNodeData).semanticCategory;
          return typeof value === 'string' && slugify(value) === semanticLabel;
        }
        return categorizeNode(node, incidentEdgesForNode(node.id, graphEdges)) === categoryKey;
      })
      .sort((a, b) => incidentEdgesForNode(b.id, graphEdges).length - incidentEdgesForNode(a.id, graphEdges).length)
      .slice(0, 16);
    const memberIds = new Set(members.map(node => node.id));
    const docs = [...documents.values()]
      .filter(doc => [...doc.nodeIds].some(nodeId => memberIds.has(nodeId)))
      .sort((a, b) => b.edgeIds.size - a.edgeIds.size)
      .slice(0, 8);

    const categoryNode = makePresentationNode(
      activeNodeId,
      category?.label ?? semanticTitle(categoryKey) ?? 'Other',
      'root',
      'Category',
      { hiddenCount: Math.max(0, members.length - 16), categoryKey },
    );
    const docNodes = docs.map(doc => makePresentationNode(
      doc.id,
      doc.title,
      'topic',
      'Document',
      {
        documentKey: doc.key,
        documentSummary: doc.snippets.slice(0, 3).join(' '),
        hiddenCount: Math.max(0, doc.nodeIds.size - 8),
      },
    ));
    const contentNodes = members.map(node => promoteNodeForView(
      node,
      'subtopic',
      {
        hiddenCount: Math.max(0, incidentEdgesForNode(node.id, graphEdges).length - 1),
        isHighlighted: highlightedNodes.has(node.id),
      },
    ));
    const presentationEdges = [
      ...docNodes.map(doc => makePresentationEdge(categoryNode.id, doc.id, 'contains')),
      ...contentNodes.map(node => makePresentationEdge(categoryNode.id, node.id, 'includes')),
      ...docs.flatMap(doc =>
        [...doc.nodeIds]
          .filter(nodeId => memberIds.has(nodeId))
          .slice(0, 8)
          .map(nodeId => makePresentationEdge(doc.id, nodeId, 'mentions'))
      ),
    ];
    const nodes = layoutVisibleNeighborhood([categoryNode, ...docNodes, ...contentNodes], presentationEdges, categoryNode.id);
    return { nodes, edges: presentationEdges };
  }

  // ── Mode: document (synthetic) — clicked a presentation:document:* node.
  // Show that document's mentioned entities, sorted by importance. ──
  if (viewMode === 'document' && activeNodeId?.startsWith(`${PRESENTATION_PREFIX}document:`)) {
    const docKey = activeNodeId.replace(`${PRESENTATION_PREFIX}document:`, '');
    const doc = documents.get(docKey);
    if (doc) {
      const relatedNodes = [...doc.nodeIds]
        .map(nodeId => realNodesById.get(nodeId))
        .filter((node): node is GraphNode => Boolean(node))
        .sort((a, b) => incidentEdgesForNode(b.id, graphEdges).length - incidentEdgesForNode(a.id, graphEdges).length)
        .slice(0, 18)
        .map(node => promoteNodeForView(
          node,
          'subtopic',
          {
            hiddenCount: Math.max(0, incidentEdgesForNode(node.id, graphEdges).length - 1),
            isHighlighted: highlightedNodes.has(node.id),
          },
        ));
      const documentNode = makePresentationNode(
        doc.id,
        doc.title,
        'root',
        'Document',
        {
          documentKey: doc.key,
          documentSummary: doc.snippets.slice(0, 5).join(' '),
          hiddenCount: Math.max(0, doc.nodeIds.size - relatedNodes.length),
        },
      );
      const presentationEdges = relatedNodes.map(node => makePresentationEdge(documentNode.id, node.id, 'mentions'));
      const nodes = layoutVisibleNeighborhood([documentNode, ...relatedNodes], presentationEdges, documentNode.id);
      return { nodes, edges: presentationEdges };
    }
  }

  // ── Mode: hub (synthetic) — fall back to bucketing nodes by inferred
  // business category when the orchestrator hasn't emitted explicit category
  // scaffolding. Same MAX_LEVEL_1_NODES cap applies. ──
  if (viewMode === 'hub') {
    const categoryCounts = new Map<BusinessCategoryKey, number>();
    const categoryMembers = new Map<BusinessCategoryKey, string[]>();
    for (const node of graphNodes) {
      if (node.id === centerNode.id) continue;
      const category = categorizeNode(node, incidentEdgesForNode(node.id, graphEdges));
      categoryCounts.set(category, (categoryCounts.get(category) ?? 0) + 1);
      categoryMembers.set(category, [...(categoryMembers.get(category) ?? []), node.id]);
    }

    const buckets: HubBucket[] = [
      ...businessCategories
        .filter(category => (categoryCounts.get(category.key) ?? 0) > 0)
        .map(category => ({
          key: category.key as BusinessCategoryKey,
          label: category.label,
          count: categoryCounts.get(category.key) ?? 0,
          memberIds: categoryMembers.get(category.key) ?? [],
        })),
      ...((categoryCounts.get('other') ?? 0) > 0
        ? [{
            key: 'other' as BusinessCategoryKey,
            label: 'Other',
            count: categoryCounts.get('other') ?? 0,
            memberIds: categoryMembers.get('other') ?? [],
          }]
        : []),
      ...(documents.size > 0
        ? [{
            key: 'documents' as BusinessCategoryKey,
            label: 'Documents',
            count: documents.size,
            memberIds: [] as string[],
          }]
        : []),
    ];

    const { kept, overflowNode } = applyHubFanoutCap(buckets);

    const visibleCategoryNodes = kept.map(bucket => makePresentationNode(
      categoryNodeId(bucket.key),
      bucket.label,
      'topic',
      'Category',
      {
        categoryKey: bucket.key,
        hiddenCount: bucket.count,
        memberIds: bucket.memberIds,
      },
    ));

    const hubNode = promoteNodeForView(
      centerNode,
      'center',
      {
        hiddenCount: Math.max(0, graphNodes.length - visibleCategoryNodes.length - 1),
        isHighlighted: highlightedNodes.has(centerNode.id),
      },
    );
    const allLevelOneNodes = [
      ...visibleCategoryNodes,
      ...(overflowNode ? [overflowNode] : []),
    ];
    const presentationEdges = allLevelOneNodes.map(node => makePresentationEdge(hubNode.id, node.id, 'branch'));
    const nodes = layoutVisibleNeighborhood([hubNode, ...allLevelOneNodes], presentationEdges, hubNode.id);
    return { nodes, edges: presentationEdges };
  }

  // ── Mode: entity (default) — center node + its 1-hop real neighbors. Also
  // the catch-all fallback for unhandled mode/state combinations. ──
  const neighborhoodIds = new Set<string>([centerNode.id]);
  for (const edge of graphEdges) {
    if (edge.source === centerNode.id) neighborhoodIds.add(edge.target);
    else if (edge.target === centerNode.id) neighborhoodIds.add(edge.source);
  }
  const visibleIds = new Set([...neighborhoodIds].filter(id => realNodesById.has(id)));
  const directEdges = graphEdges.filter(edge =>
    (edge.source === centerNode.id && visibleIds.has(edge.target)) ||
    (edge.target === centerNode.id && visibleIds.has(edge.source))
  );
  return buildFocusedNeighborView({
    centerNode,
    directEdges,
    realNodesById,
    graphEdges,
    highlightedNodes,
    neighborRole: () => 'subtopic',
  });
}

function categoryNodeId(key: string): string {
  return `${PRESENTATION_PREFIX}category:${key}`;
}

function documentNodeId(key: string): string {
  return `${PRESENTATION_PREFIX}document:${key}`;
}

function slugify(value: string): string {
  const slug = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return slug || 'unknown';
}

function semanticTitle(categoryKey: string): string | null {
  if (!categoryKey.startsWith('semantic-')) return null;
  return categoryKey
    .replace(/^semantic-/, '')
    .split('-')
    .filter(Boolean)
    .map(word => word[0]?.toUpperCase() + word.slice(1))
    .join(' ');
}

function nodeText(node: GraphNode | undefined): string {
  if (!node) return '';
  const data = node.data as GraphNodeData;
  return `${data.label ?? ''} ${data.description ?? ''} ${data.category ?? ''}`.toLowerCase();
}

function edgeText(edge: GraphEdge | undefined): string {
  if (!edge) return '';
  const data = edge.data as { predicate?: string; sourceLabel?: string } | undefined;
  return `${String(edge.label ?? '')} ${data?.predicate ?? ''} ${data?.sourceLabel ?? ''}`.toLowerCase();
}

function categorizeNode(node: GraphNode, incidentEdges: GraphEdge[]): BusinessCategoryKey {
  const data = node.data as GraphNodeData;
  if (typeof data.category === 'string') {
    return normalizeCategoryKey(data.category);
  }

  const text = `${nodeText(node)} ${incidentEdges.map(edgeText).join(' ')}`;
  const category = businessCategories.find(item => item.keywords.some(keyword => text.includes(keyword)));
  return category?.key ?? 'other';
}

function normalizeCategoryKey(value: string): BusinessCategoryKey {
  const normalized = value.toLowerCase().replace(/[_\s]+/g, '-');
  if (normalized === 'hr' || normalized === 'people' || normalized === 'hr-people') return 'hr';
  if (normalized === 'strategy-market' || normalized === 'strategy' || normalized === 'market') return 'strategy';
  if (normalized === 'documents') return 'documents';
  if (businessCategories.some(category => category.key === normalized)) return normalized as BusinessCategoryKey;
  return 'other';
}

function makePresentationNode(
  id: string,
  label: string,
  nodeType: GraphNodeData['nodeType'],
  description: string,
  extra: Record<string, unknown> = {},
): GraphNode {
  return {
    id,
    type: 'graphNode',
    position: { x: 0, y: 0 },
    data: {
      label,
      nodeType,
      description,
      isVirtualPresentation: true,
      ...extra,
    },
  };
}

function makePresentationEdge(source: string, target: string, label: string): GraphEdge {
  return {
    id: `${source}:${label}:${target}`,
    source,
    target,
    label,
    type: 'floating',
    data: { confidence: 1 },
  };
}

function incidentEdgesForNode(nodeId: string, edgeList: GraphEdge[]): GraphEdge[] {
  return edgeList.filter(edge => edge.source === nodeId || edge.target === nodeId);
}

function sourceKey(source: PresentationSource): string {
  return slugify(source.title || source.url.replace(/^local:\/\//, '') || 'source');
}

function collectDocumentContexts(edgeList: GraphEdge[]): Map<string, DocumentContext> {
  const documents = new Map<string, DocumentContext>();

  for (const edge of edgeList) {
    const sources = ((edge.data as { sources?: PresentationSource[] } | undefined)?.sources ?? []);
    for (const source of sources) {
      const key = sourceKey(source);
      const title = source.title || source.url.replace(/^local:\/\//, '') || 'Source document';
      const existing = documents.get(key) ?? {
        id: documentNodeId(key),
        key,
        title,
        snippets: [],
        nodeIds: new Set<string>(),
        edgeIds: new Set<string>(),
      };
      existing.nodeIds.add(edge.source);
      existing.nodeIds.add(edge.target);
      existing.edgeIds.add(edge.id);
      if (source.snippet && !existing.snippets.includes(source.snippet)) {
        existing.snippets.push(source.snippet);
      }
      documents.set(key, existing);
    }
  }

  return documents;
}

function layoutVisibleNeighborhood(
  graphNodes: GraphNode[],
  edgeList: GraphEdge[],
  preferredCenterId: string | null,
): GraphNode[] {
  if (graphNodes.length === 0) return graphNodes;

  const visibleIds = new Set(graphNodes.map(node => node.id));
  const centerId = preferredCenterId && visibleIds.has(preferredCenterId)
    ? preferredCenterId
    : mostConnectedNodeId(visibleIds, edgeList) ?? graphNodes[0].id;

  const centerNode = graphNodes.find(node => node.id === centerId) ?? graphNodes[0];
  const neighbors = graphNodes
    .filter(node => node.id !== centerNode.id)
    .sort((a, b) => {
      const aDirect = edgeList.some(edge =>
        (edge.source === centerNode.id && edge.target === a.id) ||
        (edge.target === centerNode.id && edge.source === a.id)
      ) ? 0 : 1;
      const bDirect = edgeList.some(edge =>
        (edge.source === centerNode.id && edge.target === b.id) ||
        (edge.target === centerNode.id && edge.source === b.id)
      ) ? 0 : 1;
      if (aDirect !== bDirect) return aDirect - bDirect;
      const aDegree = edgeList.filter(edge => edge.source === a.id || edge.target === a.id).length;
      const bDegree = edgeList.filter(edge => edge.source === b.id || edge.target === b.id).length;
      return bDegree - aDegree;
    });

  const positioned = new Map<string, { x: number; y: number }>();
  positioned.set(centerNode.id, { x: 0, y: 0 });

  let index = 0;
  let ring = 0;
  while (index < neighbors.length) {
    const remaining = neighbors.length - index;
    const radius = 250 + ring * 150;
    const capacity = Math.max(6, Math.floor((Math.PI * 2 * radius) / 210));
    const count = Math.min(remaining, capacity);
    const angleOffset = ring % 2 === 0 ? -Math.PI / 2 : -Math.PI / 2 + Math.PI / Math.max(count, 1);

    for (let i = 0; i < count; i++) {
      const node = neighbors[index + i];
      const angle = angleOffset + (Math.PI * 2 * i) / count;
      positioned.set(node.id, {
        x: Math.cos(angle) * radius,
        y: Math.sin(angle) * radius,
      });
    }

    index += count;
    ring++;
  }

  return graphNodes.map(node => ({
    ...node,
    position: positioned.get(node.id) ?? node.position,
  }));
}
