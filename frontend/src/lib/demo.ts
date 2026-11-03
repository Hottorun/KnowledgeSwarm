/**
 * Scripted stand-in for the backend, used by the public demo build
 * (`vite build --mode demo`, see .env.demo).
 *
 * Nothing here touches the network, so the demo never calls Claude or web
 * search. A run replays a prepared graph of the Acme Corp sample in
 * demo-data/knowledge-swarm-demo through a fake EventSource, using the same
 * envelopes the API streams over SSE: agent steps first, then one wave of
 * nodes and edges per specialist, so the real canvas code lays it out exactly
 * as it would a live run.
 */
import type {
  ExpandContext,
  NestLevel1Result,
  NodeCategory,
  NodeRelationship,
  SubtreeEdge,
  SubtreeNode,
} from './api';

export const NOT_IN_DEMO = 'Not available in the demo — this needs the live backend.';

interface DemoNode {
  id: string;
  label: string;
  type: string;
  properties: Record<string, unknown>;
}

interface DemoEdge {
  source: string;
  target: string;
  predicate: string;
  document: string;
  /** Scaffold edges (main → category → entity), as the orchestrator marks them. */
  presentation?: boolean;
}

interface Wave {
  agentName: string;
  message: string;
  nodes: DemoNode[];
  edges: DemoEdge[];
}

const MAIN = 'entity:acme-corp';

function entity(label: string, type: string, category: string, description: string): DemoNode {
  const slug = label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
  return { id: `entity:${slug}`, label, type, properties: { category, demoDescription: description } };
}

function category(key: string, label: string, overview: string): DemoNode {
  return {
    id: `category:${key}`,
    label,
    type: 'Category',
    properties: { category: key, presentationRole: 'business_area', summary: overview, overview },
  };
}

function document(name: string, summary: string): DemoNode {
  return {
    id: `document:${name.replace(/\.[^.]+$/, '')}`,
    label: name.replace(/\.[^.]+$/, '').replace(/-/g, ' '),
    type: 'Document',
    properties: { documentName: name, summary, category: 'documents', presentationRole: 'document', sourceKind: 'upload' },
  };
}

const PROFILE = 'acme-company-profile.md';
const ACQUISITION = 'beta-acquisition-note.md';
const CONTRACT = 'partner-contract-summary.md';
const PEOPLE = 'people.csv';
const RISK = 'risk-memo.md';

const acme: DemoNode = {
  id: MAIN,
  label: 'Acme Corp',
  type: 'Organization',
  properties: {
    presentationRole: 'main_entity',
    demoDescription: 'Renewable energy software company in Austin, Texas, building battery management software for enterprise energy storage.',
  },
};

const n = {
  strategy: category('strategy-market', 'Strategy & Market', 'Acme is moving from battery management software into solid-state battery analytics, backed by the Beta Storage acquisition.'),
  technology: category('technology', 'Technology', 'Battery management software for enterprise storage, with grid integration delivered through VoltGrid.'),
  people: category('hr-people', 'HR & People', 'Leadership across Acme and its two key partners.'),
  finance: category('finance', 'Finance', 'The March 2026 acquisition of Beta Storage is the main financial event in the documents.'),
  legal: category('legal', 'Legal', 'A supply agreement with VoltGrid GmbH with a three-year support term.'),
  operations: category('operations', 'Operations', 'Manufacturing runs through Beta Storage and partners in Germany; deployments go through VoltGrid.'),
  risk: category('risk', 'Risk', 'Supply chain, certification and regulatory exposure across Acme and its partners.'),
  documents: category('documents', 'Documents', 'The five source files this graph was built from.'),

  austin: entity('Austin, Texas', 'Location', 'strategy-market', 'Where Acme Corp is headquartered.'),
  renewables: entity('Renewable Energy Software', 'Industry', 'strategy-market', 'The market Acme Corp operates in.'),
  solidState: entity('Solid-State Battery Analytics', 'Initiative', 'strategy-market', 'The market Acme Corp is expanding into.'),
  storageStrategy: entity('Enterprise Storage Strategy', 'Strategy', 'strategy-market', 'The strategy Maya Chen says the Beta Storage acquisition supports.'),

  bms: entity('Battery Management Software', 'Product', 'technology', 'Acme Corp’s core product, for enterprise energy storage systems.'),
  gridIntegration: entity('Grid Integration Services', 'Service', 'technology', 'Provided by VoltGrid GmbH for Acme Corp deployments.'),
  modules: entity('Solid-State Battery Modules', 'Product', 'technology', 'Manufactured by Beta Storage.'),

  maya: entity('Maya Chen', 'Person', 'hr-people', 'CEO of Acme Corp.'),
  jonas: entity('Jonas Weber', 'Person', 'hr-people', 'VP Partnerships at VoltGrid GmbH.'),
  priya: entity('Priya Raman', 'Person', 'hr-people', 'Head of Manufacturing at Beta Storage.'),

  acquisition: entity('Beta Storage Acquisition', 'Transaction', 'finance', 'Acme Corp acquired Beta Storage in March 2026.'),
  march: entity('March 2026', 'Date', 'finance', 'When the Beta Storage acquisition closed.'),

  agreement: entity('VoltGrid Supply Agreement', 'Contract', 'legal', 'Supply agreement between Acme Corp and VoltGrid GmbH.'),
  supportTerm: entity('Three-Year Support Term', 'Term', 'legal', 'Support term included in the VoltGrid contract.'),

  beta: entity('Beta Storage', 'Organization', 'operations', 'Solid-state battery module manufacturer, acquired by Acme Corp.'),
  voltgrid: entity('VoltGrid GmbH', 'Organization', 'operations', 'Grid integration partner for Acme Corp deployments.'),
  germany: entity('German Manufacturing Partners', 'Organization', 'operations', 'Manufacturing partners Acme gained access to through Beta Storage.'),
  firstDeployment: entity('First VoltGrid Deployment', 'Project', 'operations', 'Will use Beta Storage components.'),

  lithium: entity('Lithium Price Volatility', 'Risk', 'risk', 'Supply chain risk for Acme Corp.'),
  cathode: entity('South Korean Cathode Suppliers', 'Organization', 'risk', 'Beta Storage depends on two of them.'),
  certification: entity('Certification Delays', 'Risk', 'risk', 'The main operational risk: delayed certification for solid-state battery systems.'),
  euRegulation: entity('EU Regulatory Exposure', 'Risk', 'risk', 'VoltGrid GmbH’s exposure in the European Union energy market.'),

  docProfile: document(PROFILE, 'Who Acme Corp is, what it builds, who leads it and where it is heading.'),
  docAcquisition: document(ACQUISITION, 'The March 2026 acquisition of Beta Storage and what it brings.'),
  docContract: document(CONTRACT, 'The VoltGrid GmbH supply agreement and its support term.'),
  docPeople: document(PEOPLE, 'Key people at Acme Corp, VoltGrid GmbH and Beta Storage.'),
  docRisk: document(RISK, 'Supply chain, regulatory and certification risks.'),
};

const area = (cat: DemoNode, document_: string): DemoEdge => ({ source: MAIN, target: cat.id, predicate: 'has_business_area', document: document_, presentation: true });
const contains = (cat: DemoNode, member: DemoNode, document_: string): DemoEdge => ({ source: cat.id, target: member.id, predicate: 'contains', document: document_, presentation: true });
const rel = (source: DemoNode, predicate: string, target: DemoNode, document_: string): DemoEdge => ({ source: source.id, target: target.id, predicate, document: document_ });
/** Nests a detail under an entity rather than its category, like the orchestrator's hierarchical parents. */
const detail = (parent: DemoNode, predicate: string, child: DemoNode, document_: string): DemoEdge => ({ ...rel(parent, predicate, child, document_), presentation: true });

const WAVES: Wave[] = [
  {
    agentName: 'MarketAgent',
    message: 'Identified Acme Corp as the main entity and mapped its market position',
    nodes: [acme, n.strategy, n.austin, n.renewables, n.solidState, n.storageStrategy],
    edges: [
      area(n.strategy, PROFILE),
      contains(n.strategy, n.austin, PROFILE),
      contains(n.strategy, n.renewables, PROFILE),
      contains(n.strategy, n.solidState, PROFILE),
      contains(n.strategy, n.storageStrategy, ACQUISITION),
    ],
  },
  {
    agentName: 'TechnicalAgent',
    message: 'Extracted products and services',
    nodes: [n.technology, n.bms, n.gridIntegration, n.modules],
    edges: [
      area(n.technology, PROFILE),
      contains(n.technology, n.bms, PROFILE),
      contains(n.technology, n.gridIntegration, CONTRACT),
      contains(n.technology, n.modules, ACQUISITION),
    ],
  },
  {
    agentName: 'PeopleOrgAgent',
    message: 'Extracted 3 people and their roles',
    nodes: [n.people, n.maya, n.jonas, n.priya],
    edges: [
      area(n.people, PEOPLE),
      contains(n.people, n.maya, PEOPLE),
      contains(n.people, n.jonas, PEOPLE),
      contains(n.people, n.priya, PEOPLE),
    ],
  },
  {
    agentName: 'FinanceAgent',
    message: 'Found the Beta Storage acquisition',
    nodes: [n.finance, n.acquisition, n.march],
    edges: [
      area(n.finance, ACQUISITION),
      contains(n.finance, n.acquisition, ACQUISITION),
      detail(n.acquisition, 'closed_in', n.march, ACQUISITION),
    ],
  },
  {
    agentName: 'LegalAgent',
    message: 'Extracted the VoltGrid supply agreement',
    nodes: [n.legal, n.agreement, n.supportTerm],
    edges: [
      area(n.legal, CONTRACT),
      contains(n.legal, n.agreement, CONTRACT),
      detail(n.agreement, 'includes', n.supportTerm, CONTRACT),
    ],
  },
  {
    agentName: 'GeneralAgent',
    message: 'Mapped partners, manufacturing and deployments',
    nodes: [n.operations, n.beta, n.voltgrid, n.germany, n.firstDeployment],
    edges: [
      area(n.operations, ACQUISITION),
      contains(n.operations, n.beta, ACQUISITION),
      contains(n.operations, n.voltgrid, CONTRACT),
      contains(n.operations, n.germany, ACQUISITION),
      contains(n.operations, n.firstDeployment, CONTRACT),
      rel(n.beta, 'manufactures', n.modules, ACQUISITION),
      rel(n.voltgrid, 'provides', n.gridIntegration, CONTRACT),
      rel(n.firstDeployment, 'uses_components_from', n.beta, CONTRACT),
    ],
  },
  {
    agentName: 'RiskAgent',
    message: 'Flagged 3 risks and a supplier dependency',
    nodes: [n.risk, n.lithium, n.cathode, n.certification, n.euRegulation],
    edges: [
      area(n.risk, RISK),
      contains(n.risk, n.lithium, RISK),
      contains(n.risk, n.cathode, RISK),
      contains(n.risk, n.certification, RISK),
      contains(n.risk, n.euRegulation, RISK),
      rel(n.beta, 'depends_on', n.cathode, RISK),
      rel(n.voltgrid, 'exposed_to', n.euRegulation, RISK),
    ],
  },
  {
    agentName: 'MetaAgent',
    message: 'Linked every fact back to its source document',
    nodes: [n.documents, n.docProfile, n.docAcquisition, n.docContract, n.docPeople, n.docRisk],
    edges: [
      area(n.documents, PROFILE),
      contains(n.documents, n.docProfile, PROFILE),
      contains(n.documents, n.docAcquisition, ACQUISITION),
      contains(n.documents, n.docContract, CONTRACT),
      contains(n.documents, n.docPeople, PEOPLE),
      contains(n.documents, n.docRisk, RISK),
    ],
  },
];

/** A few nodes have more to show when expanded. */
const EXPANSIONS: Record<string, { summary: string; nodes: DemoNode[]; edges: Array<{ predicate: string; target: DemoNode }> }> = {
  [n.beta.id]: {
    summary: 'Beta Storage brings solid-state module manufacturing, a German partner network and Priya Raman’s team.',
    nodes: [n.priya, n.germany],
    edges: [
      { predicate: 'led_by', target: n.priya },
      { predicate: 'works_with', target: n.germany },
    ],
  },
  [n.voltgrid.id]: {
    summary: 'VoltGrid GmbH is Acme’s grid integration partner under a three-year support agreement, led on the partnership side by Jonas Weber.',
    nodes: [n.jonas, n.agreement],
    edges: [
      { predicate: 'represented_by', target: n.jonas },
      { predicate: 'party_to', target: n.agreement },
    ],
  },
  [n.maya.id]: {
    summary: 'Maya Chen leads Acme Corp and backed the Beta Storage acquisition as part of the enterprise storage strategy.',
    nodes: [n.storageStrategy, n.acquisition],
    edges: [
      { predicate: 'champions', target: n.storageStrategy },
      { predicate: 'announced', target: n.acquisition },
    ],
  },
};

const ALL_NODES = WAVES.flatMap(wave => wave.nodes);
const ALL_EDGES = WAVES.flatMap(wave => wave.edges);

// ── Fake EventSource ─────────────────────────────────────────────────────────

type Listener = (event: MessageEvent) => void;

class DemoEventSource {
  private listeners = new Map<string, Set<Listener>>();
  closed = false;

  addEventListener(type: string, listener: Listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, new Set());
    this.listeners.get(type)!.add(listener);
  }

  removeEventListener(type: string, listener: Listener) {
    this.listeners.get(type)?.delete(listener);
  }

  close() {
    this.closed = true;
    this.listeners.clear();
  }

  emit(runId: string, type: string, payload: unknown) {
    if (this.closed) return;
    const data = JSON.stringify({ type, runId, timestamp: new Date().toISOString(), payload });
    const event = new MessageEvent(type, { data });
    this.listeners.get(type)?.forEach(listener => listener(event));
  }
}

const streams = new Map<string, DemoEventSource>();
let runCounter = 0;

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

function streamFor(runId: string): DemoEventSource {
  const stream = streams.get(runId);
  if (!stream) throw new Error('Demo run not found');
  return stream;
}

function step(stream: DemoEventSource, runId: string, agentName: string, eventType: string, message: string) {
  stream.emit(runId, 'agent.step', { agentName, eventType, message });
}

function emitEdge(stream: DemoEventSource, runId: string, edge: DemoEdge) {
  stream.emit(runId, 'edge.created', {
    edge: {
      source: edge.source,
      target: edge.target,
      predicate: edge.predicate,
      confidence: 0.9,
      sources: [{ url: `local://${edge.document}`, title: edge.document }],
      properties: edge.presentation ? { presentation: true } : {},
    },
  });
}

// ── API stand-ins ────────────────────────────────────────────────────────────

export function createRun(): string {
  const runId = `demo-run-${++runCounter}`;
  streams.set(runId, new DemoEventSource());
  return runId;
}

export function openRunStream(runId: string): EventSource {
  return streamFor(runId) as unknown as EventSource;
}

/**
 * Whatever was submitted, the demo builds the Acme Corp graph. The gaps between
 * waves are longer than the canvas's 600ms layout debounce, so each specialist's
 * branch lands as its own step instead of the whole graph at once.
 */
export async function extractFromText(runId: string): Promise<void> {
  const stream = streamFor(runId);
  if (stream.closed) return;

  step(stream, runId, 'MetaAgent', 'chunking', 'Reading 5 Acme Corp documents');
  await sleep(700);
  step(stream, runId, 'MetaAgent', 'decomposing', 'Analyzing document structure');
  await sleep(700);
  step(stream, runId, 'MetaAgent', 'dispatching', `${WAVES.length - 1} specialists in parallel`);
  await sleep(800);

  for (const wave of WAVES) {
    if (stream.closed) return;
    step(stream, runId, wave.agentName, 'extracting', wave.message);
    for (const node of wave.nodes) stream.emit(runId, 'node.created', { node });
    for (const edge of wave.edges) emitEdge(stream, runId, edge);
    await sleep(1400);
  }

  step(stream, runId, 'MetaAgent', 'completed', `Built ${ALL_NODES.length} nodes and ${ALL_EDGES.length} relationships`);
  stream.emit(runId, 'run.completed', { message: 'Demo graph complete' });
}

export function categorizeNodes(nodes: Array<{ id: string; label: string; type: string }>): NodeCategory[] {
  const byLabel = new Map(ALL_NODES.map(node => [node.label, node]));
  const groups = new Map<string, string[]>();
  for (const node of nodes) {
    const key = byLabel.get(node.label)?.properties.category;
    const label = WAVES.flatMap(w => w.nodes).find(c => c.type === 'Category' && c.properties.category === key)?.label;
    if (label) groups.set(label, [...(groups.get(label) ?? []), node.id]);
  }
  return [...groups].map(([label, nodeIds]) => ({ label, nodeIds }));
}

export function nestLevel1Entities(): NestLevel1Result {
  return { assignments: [], newTriplesPersisted: 0 };
}

export function describeNode(label: string, _entityType: string, relationships: NodeRelationship[]): string {
  const known = ALL_NODES.find(node => node.label === label)?.properties.demoDescription;
  if (typeof known === 'string') return known;
  const first = relationships[0];
  return first
    ? `${label} ${first.direction === 'out' ? first.predicate.replace(/_/g, ' ') : `is linked by "${first.predicate.replace(/_/g, ' ')}" to`} ${first.otherLabel}.`
    : `${label} appears in the Acme Corp documents.`;
}

/** Answers from the prepared graph: what the question mentions, and how it connects. */
export async function queryGraph(
  _runId: string,
  question: string,
  nodes: SubtreeNode[],
  edges: SubtreeEdge[],
): Promise<{ answer: string; newTriplesPersisted: number; searchQueries: string[] }> {
  await sleep(900);
  const q = question.toLowerCase();
  // Prefer the longest full name in the question ("Beta Storage" over "Beta
  // Storage Acquisition"), then fall back to a node's first word.
  const byLength = [...nodes].sort((a, b) => b.label.length - a.label.length);
  const focus =
    byLength.find(node => q.includes(node.label.toLowerCase())) ??
    byLength.find(node => node.type !== 'Category' && node.label.length > 3 && q.includes(node.label.toLowerCase().split(/[ ,]/)[0]));

  if (!focus) {
    return {
      answer: 'In this demo, answers come from the prepared Acme Corp graph rather than a live model. Try asking about Beta Storage, VoltGrid, Maya Chen or the risks.',
      newTriplesPersisted: 0,
      searchQueries: [],
    };
  }

  const facts = edges
    .filter(edge => (edge.subjectLabel === focus.label || edge.objectLabel === focus.label) && edge.predicate !== 'contains' && edge.predicate !== 'has_business_area')
    .map(edge => `${edge.subjectLabel} ${edge.predicate.replace(/_/g, ' ')} ${edge.objectLabel}`);
  const description = ALL_NODES.find(node => node.label === focus.label)?.properties.demoDescription;
  const answer = [description, ...facts.map(fact => `${fact}.`)].filter(Boolean).join(' ');
  return {
    answer: answer || `${focus.label} appears in the Acme Corp documents.`,
    newTriplesPersisted: 0,
    searchQueries: [],
  };
}

export async function expandSubtree(
  runId: string,
  rootNode: SubtreeNode,
  _nodes: SubtreeNode[],
  _edges: SubtreeEdge[],
  _question?: string,
  _ctx?: ExpandContext,
): Promise<{ summary: string; newTriplesPersisted: number }> {
  await sleep(900);
  const stream = streams.get(runId);
  const expansion = EXPANSIONS[rootNode.id];
  if (!stream || !expansion) {
    return {
      summary: 'In the demo, Beta Storage, VoltGrid GmbH and Maya Chen have more to expand. A live run would research any node.',
      newTriplesPersisted: 0,
    };
  }
  for (const node of expansion.nodes) stream.emit(runId, 'node.created', { node });
  for (const edge of expansion.edges) {
    emitEdge(stream, runId, { source: rootNode.id, target: edge.target.id, predicate: edge.predicate, document: 'demo' });
  }
  return { summary: expansion.summary, newTriplesPersisted: expansion.edges.length };
}
