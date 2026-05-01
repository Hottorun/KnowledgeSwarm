import { type EdgeProps, Position, getBezierPath, useInternalNode } from '@xyflow/react';

const compactDotSize: Record<string, number> = { root: 36, topic: 28, subtopic: 22, detail: 18 };

function getNodeCenter(node: any) {
  const pos = node.internals?.positionAbsolute ?? node.positionAbsolute ?? node.position;
  const fullW = node.measured?.width ?? node.width ?? 40;
  const fullH = node.measured?.height ?? node.height ?? 40;

  // When compact, the dot is centered inside the full bounding box.
  // Use dot dimensions so edges attach to the dot's edge, not the card's edge.
  const nodeData = node.data as any;
  if (nodeData?.compact === true) {
    const dot = compactDotSize[nodeData?.nodeType] ?? 22;
    return { x: pos.x + fullW / 2, y: pos.y + fullH / 2, w: dot, h: dot };
  }

  return { x: pos.x + fullW / 2, y: pos.y + fullH / 2, w: fullW, h: fullH };
}

const posMap = { top: Position.Top, bottom: Position.Bottom, left: Position.Left, right: Position.Right } as const;

function getHandlePosition(center: { x: number; y: number; w: number; h: number }, otherCenter: { x: number; y: number }) {
  const dx = otherCenter.x - center.x;
  const dy = otherCenter.y - center.y;
  const absDx = Math.abs(dx);
  const absDy = Math.abs(dy);

  if (absDx > absDy) {
    // horizontal dominant
    if (dx > 0) return { x: center.x + center.w / 2, y: center.y, pos: 'right' as const };
    return { x: center.x - center.w / 2, y: center.y, pos: 'left' as const };
  }
  // vertical dominant
  if (dy > 0) return { x: center.x, y: center.y + center.h / 2, pos: 'bottom' as const };
  return { x: center.x, y: center.y - center.h / 2, pos: 'top' as const };
}

export function FloatingEdge({ id, source, target, style, markerEnd }: EdgeProps) {
  const sourceNode = useInternalNode(source);
  const targetNode = useInternalNode(target);

  if (!sourceNode || !targetNode) return null;

  const sourceCenter = getNodeCenter(sourceNode);
  const targetCenter = getNodeCenter(targetNode);

  const sourceHandle = getHandlePosition(sourceCenter, targetCenter);
  const targetHandle = getHandlePosition(targetCenter, sourceCenter);

  const [path] = getBezierPath({
    sourceX: sourceHandle.x,
    sourceY: sourceHandle.y,
    sourcePosition: posMap[sourceHandle.pos],
    targetX: targetHandle.x,
    targetY: targetHandle.y,
    targetPosition: posMap[targetHandle.pos],
    curvature: 0.25,
  });

  return (
    <path
      id={id}
      d={path}
      fill="none"
      stroke="var(--kg-edge)"
      strokeWidth={1.2}
      strokeOpacity={0.5}
      style={style}
      markerEnd={markerEnd as string}
    />
  );
}