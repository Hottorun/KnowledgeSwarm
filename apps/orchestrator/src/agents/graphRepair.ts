import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import type { Triple, GraphNode } from '../types';
import type { ConnectedComponent } from '../ingest/normalizer';
import { analyzeConnectedComponents, normalizeTriples } from '../ingest/normalizer';
import { parseJsonArrayPropertyItems, parseJsonObject } from './json';
import { withAnthropicLimit } from './anthropicLimiter';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

interface BridgeOutput {
  bridges: BridgeSuggestion[];
}

interface BridgeSuggestion {
  subjectId: string;
  predicate: string;
  objectId: string;
  confidence?: number;
  reason?: string;
  snippet?: string;
}

const SYSTEM_PROMPT = `You are ConnectivityAgent, a graph repair reviewer.

The extraction swarm produced multiple disconnected knowledge graph components. Your job is to add the minimum inferred bridge edges needed so every node can be reached from every other node.

Output ONLY valid JSON:
{"bridges":[{"subjectId":"existing-node-id","predicate":"specific_relation","objectId":"existing-node-id","confidence":0.55,"reason":"short inference rationale","snippet":"short supporting evidence"}]}

Rules:
- Use ONLY existing node IDs from the component summaries.
- Do not invent nodes.
- Add at most one bridge from the main component to each disconnected component.
- Prefer concrete predicates like employs, owns, supplies, governed_by, contracts_with, reports_to, uses, sells, operates_in, exposed_to.
- Use "related_to" only when no more specific predicate is defensible.
- Confidence must be 0.50 to 0.75 because these are inferred repair links.
- Keep JSON compact.`;

export async function repairDisconnectedGraph(
  triples: Triple[],
  components: ConnectedComponent[],
  documentName: string,
): Promise<Triple[]> {
  if (components.length <= 1) return [];

  if (config.stubMode) {
    return deterministicBridgeTriples(triples, components, documentName, 'stub connectivity repair');
  }

  if (components.length > config.graphRepairMaxComponents) {
    console.warn(`[connectivity] ${components.length} components exceeds AI repair cap; using conservative deterministic bridges`);
    return deterministicBridgeTriples(
      triples,
      components,
      documentName,
      `component count ${components.length} exceeded GRAPH_REPAIR_MAX_COMPONENTS`,
    );
  }

  const nodeById = buildNodeIndex(triples);
  const componentByNode = buildComponentIndex(components);
  const prompt = buildRepairPrompt(components, documentName);

  try {
    const response = await withAnthropicLimit(() => client.messages.create({
      model: config.supervisorModel,
      max_tokens: 1200,
      system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
      messages: [{ role: 'user', content: prompt }],
    }));

    const text = response.content.find(block => block.type === 'text')?.text ?? '';
    const suggestions = parseBridgeSuggestions(text);
    const bridges = suggestions
      .map(suggestion => bridgeSuggestionToTriple(suggestion, nodeById, componentByNode, documentName))
      .filter((triple): triple is Triple => Boolean(triple));

    if (bridges.length > 0) {
      const repairedTriples = normalizeTriples([...triples, ...bridges]);
      const remainingComponents = analyzeConnectedComponents(repairedTriples);
      if (remainingComponents.length <= 1) {
        return bridges;
      }

      const fallbackBridges = deterministicBridgeTriples(
        repairedTriples,
        remainingComponents,
        documentName,
        'AI repair did not connect every component',
      );
      return [...bridges, ...fallbackBridges];
    }
  } catch (error) {
    console.warn('[connectivity] AI graph repair failed; using deterministic repair:', error);
  }

  return deterministicBridgeTriples(triples, components, documentName, 'AI repair unavailable');
}

function parseBridgeSuggestions(text: string): BridgeSuggestion[] {
  try {
    const output = parseJsonObject<BridgeOutput>(text);
    return Array.isArray(output.bridges) ? output.bridges : [];
  } catch {
    return parseJsonArrayPropertyItems(text, 'bridges') as BridgeSuggestion[];
  }
}

function buildRepairPrompt(components: ConnectedComponent[], documentName: string): string {
  const summaries = components.map((component, index) => ({
    componentIndex: index,
    nodeCount: component.nodeIds.length,
    representativeNodes: representativeNodes(component).map(node => ({
      id: node.id,
      label: node.label,
      type: node.type,
    })),
    representativeTriples: component.triples.slice(0, 6).map(triple => ({
      subjectId: triple.subject.id,
      predicate: triple.predicate,
      objectId: triple.object.id,
      source: triple.sources?.[0]?.snippet || triple.sources?.[0]?.title || documentName,
    })),
  }));

  return `Source document: ${documentName}

Component 0 is the main graph component. Add bridge edges from component 0 to each other component where the available evidence supports a likely relation.

Disconnected component summaries:
${JSON.stringify(summaries)}`;
}

function representativeNodes(component: ConnectedComponent): GraphNode[] {
  const nodes = new Map<string, GraphNode>();

  for (const triple of component.triples) {
    nodes.set(triple.subject.id, triple.subject);
    nodes.set(triple.object.id, triple.object);
    if (nodes.size >= 8) break;
  }

  return [...nodes.values()];
}

function bridgeSuggestionToTriple(
  suggestion: BridgeSuggestion,
  nodeById: Map<string, GraphNode>,
  componentByNode: Map<string, number>,
  documentName: string,
): Triple | null {
  const subject = nodeById.get(suggestion.subjectId);
  const object = nodeById.get(suggestion.objectId);
  if (!subject || !object) return null;
  if (subject.id === object.id) return null;
  if (componentByNode.get(subject.id) === componentByNode.get(object.id)) return null;

  const predicate = sanitizePredicate(suggestion.predicate);
  const confidence = clampConfidence(suggestion.confidence ?? 0.55);
  const reason = suggestion.reason || 'Inferred bridge between disconnected graph components';

  return {
    subject,
    predicate,
    object,
    confidence,
    sources: [{
      url: `local://${encodeURIComponent(documentName)}`,
      title: documentName,
      snippet: suggestion.snippet || reason,
    }],
    properties: {
      inferred: true,
      repairAgent: 'ConnectivityAgent',
      reason,
      documentName,
    },
  };
}

function deterministicBridgeTriples(
  triples: Triple[],
  components: ConnectedComponent[],
  documentName: string,
  reason: string,
): Triple[] {
  const nodeById = buildNodeIndex(triples);
  const main = components[0];
  if (!main) return [];

  const mainNode = selectHubNode(main, nodeById);
  if (!mainNode) return [];

  return components.slice(1).flatMap(component => {
    const targetNode = selectHubNode(component, nodeById);
    if (!targetNode) return [];

    return [{
      subject: mainNode,
      predicate: 'co_mentioned_with',
      object: targetNode,
      confidence: 0.5,
      sources: [{
        url: `local://${encodeURIComponent(documentName)}`,
        title: documentName,
        snippet: `Connectivity repair inferred a bridge because both components were extracted from ${documentName}.`,
      }],
      properties: {
        inferred: true,
        repairAgent: 'ConnectivityAgent',
        deterministic: true,
        reason,
        documentName,
      },
    }];
  });
}

function selectHubNode(component: ConnectedComponent, nodeById: Map<string, GraphNode>): GraphNode | null {
  const degree = new Map<string, number>();
  for (const triple of component.triples) {
    degree.set(triple.subject.id, (degree.get(triple.subject.id) ?? 0) + 1);
    degree.set(triple.object.id, (degree.get(triple.object.id) ?? 0) + 1);
  }

  const bestId = [...component.nodeIds].sort((a, b) => (degree.get(b) ?? 0) - (degree.get(a) ?? 0))[0];
  return bestId ? nodeById.get(bestId) ?? null : null;
}

function buildNodeIndex(triples: Triple[]): Map<string, GraphNode> {
  const nodes = new Map<string, GraphNode>();
  for (const triple of triples) {
    nodes.set(triple.subject.id, triple.subject);
    nodes.set(triple.object.id, triple.object);
  }
  return nodes;
}

function buildComponentIndex(components: ConnectedComponent[]): Map<string, number> {
  const index = new Map<string, number>();
  components.forEach((component, componentIndex) => {
    component.nodeIds.forEach(nodeId => index.set(nodeId, componentIndex));
  });
  return index;
}

function sanitizePredicate(predicate: string | undefined): string {
  const clean = (predicate || 'related_to')
    .toLowerCase()
    .replace(/[^a-z0-9_ -]+/g, '')
    .trim()
    .replace(/[\s-]+/g, '_');
  return clean || 'related_to';
}

function clampConfidence(value: number): number {
  if (!Number.isFinite(value)) return 0.55;
  return Math.max(0.5, Math.min(0.75, value));
}
