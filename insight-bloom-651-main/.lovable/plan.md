## Problem

Edges always connect from the bottom handle of the source to the top handle of the target, regardless of their relative positions. In a radial layout, this causes unnatural bending when nodes are beside or below their parent.

## Solution

Implement floating edges that dynamically connect to the nearest point on each node and curve naturally based on relative position.

### Changes

**1. Add a custom FloatingEdge component** (`src/components/knowledge-graph/FloatingEdge.tsx`)
- Calculate the angle between source and target node centers
- Pick the closest handle position (top/bottom/left/right) on each node based on that angle
- Use `getBezierPath` with dynamically calculated control points that follow the natural direction between nodes

**2. Update GraphNode.tsx**
- Add Left and Right handles (currently only Top and Bottom exist) so edges can attach from any direction
- Keep handles invisible/minimal as they are now

**3. Update KnowledgeGraphCanvas.tsx**
- Register the custom `FloatingEdge` as an edge type
- Change all edge `type: 'default'` to `type: 'floating'`

This will make lines take the shortest path between nodes with smooth, natural curves that adapt to node placement.
