import Anthropic from '@anthropic-ai/sdk';
import { config } from '../config';
import { search } from '../tools/search';
import { emitAgentEvent, emitTriples } from '../tools/emit';
import { STUB_TRIPLES } from '../stubs/fixtures';
import type { ExpandRequest, Triple } from '../types';

const client = new Anthropic({ apiKey: config.anthropicApiKey });

const SYSTEM_PROMPT = `You are a knowledge expansion agent. Given a graph node and related context, extract new knowledge triples that deepen understanding of that node.

Output ONLY valid JSON — no markdown:
{"triples":[{"subject":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"predicate":"verb_phrase","object":{"id":"type:slug","label":"Label","type":"EntityType","properties":{}},"confidence":0.0,"sources":[{"url":"","title":"","snippet":""}],"properties":{}}]}

Rules:
- All triples must involve the focus node as subject OR object
- Only state facts supported by the provided context
- Confidence: 0.9+ explicit | 0.7–0.9 implication | discard below 0.6
- Keep JSON compact`;

export async function expandNode(req: ExpandRequest): Promise<Triple[]> {
  const { runId, nodeId, nodeLabel, nodeType, context } = req;
  const agentName = `Expander:${nodeId}`;

  await emitAgentEvent(runId, agentName, 'expanding', `Expanding node: ${nodeLabel} (${nodeType})`);

  // Search for external context about this node
  const searchQuery = context
    ? `${nodeLabel} ${context}`
    : `${nodeLabel} ${nodeType}`;

  const results = await search(searchQuery);

  if (results.length === 0) {
    await emitAgentEvent(runId, agentName, 'done', 'No results found for expansion');
    return [];
  }

  if (config.stubMode) {
    const stubExpanded = STUB_TRIPLES.map(t => ({
      ...t,
      subject: t.subject.id === nodeId ? t.subject : { ...t.subject, id: nodeId, label: nodeLabel, type: nodeType },
    }));
    await emitAgentEvent(runId, agentName, 'done', `stub: ${stubExpanded.length} new triple(s)`);
    await emitTriples(runId, agentName, stubExpanded);
    return stubExpanded;
  }

  const contextText = results
    .map(r => `SOURCE: ${r.url}\n${r.title}\n${r.snippet}${r.content ? '\n' + r.content : ''}`)
    .join('\n\n---\n\n');

  const userMessage = `Focus node: ${nodeLabel} (type: ${nodeType}, id: ${nodeId})\n\nContext:\n${contextText}`;

  const response = await client.messages.create({
    model: config.expanderModel,
    max_tokens: 2048,
    system: [{ type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }],
    messages: [{ role: 'user', content: userMessage }],
  });

  const text = response.content.find(b => b.type === 'text')?.text ?? '';
  const { triples } = JSON.parse(text) as { triples: Triple[] };

  await emitAgentEvent(runId, agentName, 'done', `${triples.length} new triple(s) added`);
  await emitTriples(runId, agentName, triples);

  return triples;
}
