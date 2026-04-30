import { type EdgeProps, Position, getBezierPath, useInternalNode } from '@xyflow/react';

function getNodeCenter(node: any) {
  const pos = node.internals?.positionAbsolute ?? node.positionAbsolute ?? node.position;
  const w = node.measured?.width ?? node.width ?? 40;
  const h = node.measured?.height ?? node.height ?? 40;
  return { x: pos.x + w / 2, y: pos.y + h / 2, w, h };
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