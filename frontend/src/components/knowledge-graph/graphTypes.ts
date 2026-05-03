export interface GraphNodeData {
  label: string;
  description?: string;
  nodeType: 'root' | 'topic' | 'subtopic' | 'detail';
  isHighlighted?: boolean;
  compact?: boolean;
  animDelay?: number;
  isExpanding?: boolean;
  hiddenCount?: number;
  [key: string]: unknown;
}

export interface GraphNode<TData = GraphNodeData> {
  id: string;
  type?: string;
  position: { x: number; y: number };
  data: TData;
  selected?: boolean;
  style?: Record<string, unknown>;
  measured?: { width?: number; height?: number };
  [key: string]: unknown;
}

export interface GraphEdge<TData = Record<string, unknown>> {
  id: string;
  source: string;
  target: string;
  type?: string;
  label?: string;
  data?: TData;
  animated?: boolean;
  hidden?: boolean;
  selected?: boolean;
  style?: Record<string, unknown>;
  [key: string]: unknown;
}

export const nodeDims: Record<string, { w: number; h: number; dot: number; px: number; py: number; r: string }> = {
  root:     { w: 210, h: 76, dot: 40, px: 22, py: 18, r: '1rem'    },
  topic:    { w: 175, h: 62, dot: 32, px: 18, py: 14, r: '1rem'    },
  subtopic: { w: 130, h: 46, dot: 22, px: 12, py: 10, r: '0.75rem' },
  detail:   { w: 110, h: 40, dot: 18, px: 12, py:  8, r: '0.75rem' },
};

export const charWidths: Record<string, number> = {
  root: 8, topic: 7, subtopic: 6.5, detail: 6,
};

export const LABEL_WRAP_AT = 25;

const BADGE_WALL_CLEARANCE = 12;

export function calcNodeDims(
  nodeType: string,
  label: string,
  description: string | undefined,
  hasAccent: boolean,
) {
  const base = nodeDims[nodeType] ?? nodeDims.detail;
  const charW = charWidths[nodeType] ?? 6;
  const lineH = nodeType === 'root' ? 24 : nodeType === 'topic' ? 20 : 18;

  const labelLines = Math.ceil(label.length / LABEL_WRAP_AT);
  const effectiveLineChars = Math.min(label.length, LABEL_WRAP_AT);

  const badgeW = hasAccent && description ? description.length * 6 + 12 : 0;
  const innerW = 16 + effectiveLineChars * charW + (badgeW > 0 ? 8 + badgeW : 0);
  const rightPad = base.px + (badgeW > 0 ? BADGE_WALL_CLEARANCE : 0);
  const w = Math.max(base.w, Math.ceil(innerW + base.px + rightPad));

  let h = Math.max(base.h, base.py * 2 + labelLines * lineH);

  if (description && !hasAccent) {
    const availW = w - 2 * base.px - 16;
    const charsPerLine = Math.max(Math.floor(availW / 5.5), 1);
    const extraLines = Math.max(0, Math.ceil(description.length / charsPerLine) - 1);
    h += extraLines * 18;
  }

  return { ...base, w, h };
}
