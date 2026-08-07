import {
  Background,
  ConnectionMode,
  Controls,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useEdgesState,
  useNodesState,
  type Connection,
  type Edge,
  type Node,
  type OnConnect,
  type Viewport,
  type XYPosition,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef } from "react";
import type { BrainAction, StudyBrain } from "../../lib/study-brain/types";
import { positionAroundBrain } from "../../lib/study-brain/storage";
import { BrainNodeView } from "./nodes/BrainNode";
import { SourceNodeView } from "./nodes/SourceNode";

const nodeTypes = {
  brain: BrainNodeView,
  source: SourceNodeView,
};

const EDGE_STYLE = {
  stroke: "rgba(15, 23, 42, 0.16)",
  strokeWidth: 1.35,
};

type SideId = "left" | "right" | "top" | "bottom";

/** Which side of `from` faces toward `to` — used for straight hub spokes. */
function facingSide(from: XYPosition, to: XYPosition): SideId {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? "right" : "left";
  return dy >= 0 ? "bottom" : "top";
}

function brainToFlow(brain: StudyBrain, processing: boolean, onAction: (action: BrainAction) => void) {
  const brainPos = brain.positions.brain || { x: 420, y: 280 };
  const nodes: Node[] = [
    {
      id: "brain",
      type: "brain",
      position: brainPos,
      data: {
        title: brain.title,
        processing,
        connectedCount: brain.connections.length,
        onAction,
      },
      draggable: true,
      dragHandle: ".study-brain-drag-handle",
    },
  ];
  brain.sources.forEach((source, index) => {
    nodes.push({
      id: source.id,
      type: "source",
      position: brain.positions[source.id] || positionAroundBrain(brainPos, index),
      data: { source: { ...source, connected: brain.connections.includes(source.id) } },
    });
  });
  const edges: Edge[] = brain.connections.map((sourceId) => {
    const sourcePos = brain.positions[sourceId] || brainPos;
    return {
      id: `e-${sourceId}-brain`,
      type: "straight",
      source: sourceId,
      target: "brain",
      sourceHandle: facingSide(sourcePos, brainPos),
      targetHandle: facingSide(brainPos, sourcePos),
      animated: processing,
      style: EDGE_STYLE,
    };
  });
  return { nodes, edges };
}

function CanvasInner({
  brain,
  processing,
  onBrainChange,
  onAction,
  onSelectSource,
}: {
  brain: StudyBrain;
  processing: boolean;
  onBrainChange: (next: StudyBrain) => void;
  onAction: (action: BrainAction) => void;
  onSelectSource: (id: string | null) => void;
}) {
  const initial = useMemo(() => brainToFlow(brain, processing, onAction), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const brainRef = useRef(brain);
  brainRef.current = brain;
  const actionRef = useRef(onAction);
  actionRef.current = onAction;

  useEffect(() => {
    const next = brainToFlow(brain, processing, (action) => actionRef.current(action));
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [brain, processing, setNodes, setEdges]);

  const persistLayout = useCallback(
    (nextNodes: Node[], nextEdges: Edge[], viewport?: Viewport) => {
      const current = brainRef.current;
      const positions: StudyBrain["positions"] = { ...current.positions };
      for (const node of nextNodes) {
        positions[node.id] = { x: node.position.x, y: node.position.y };
      }
      const connections = nextEdges
        .filter((edge) => edge.target === "brain" || edge.source === "brain")
        .map((edge) => (edge.target === "brain" ? edge.source : edge.target))
        .filter((id) => id !== "brain");
      onBrainChange({
        ...current,
        positions,
        connections: [...new Set(connections)],
        sources: current.sources.map((source) => ({
          ...source,
          connected: connections.includes(source.id),
        })),
        viewport: viewport || current.viewport,
        updatedAt: Date.now(),
      });
    },
    [onBrainChange],
  );

  const onConnect: OnConnect = useCallback(
    (connection: Connection) => {
      setEdges((eds) => {
        const next = addEdge(
          {
            ...connection,
            type: "straight",
            animated: false,
            style: EDGE_STYLE,
          },
          eds,
        );
        persistLayout(nodes, next);
        return next;
      });
    },
    [nodes, persistLayout, setEdges],
  );

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      defaultEdgeOptions={{ type: "straight", style: EDGE_STYLE }}
      connectionMode={ConnectionMode.Loose}
      onNodesChange={(changes) => {
        onNodesChange(changes);
      }}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onNodeDragStop={(_event, _node, nextNodes) => persistLayout(nextNodes, edges)}
      onSelectionChange={({ nodes: selected }) => {
        const source = selected.find((node) => node.type === "source");
        onSelectSource(source?.id || null);
      }}
      onMoveEnd={(_event, viewport) => persistLayout(nodes, edges, viewport)}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.35}
      maxZoom={1.6}
      snapToGrid
      snapGrid={[16, 16]}
      panOnScroll
      selectionOnDrag
      className="study-brain-flow bg-[color:var(--clyra-canvas)]"
      proOptions={{ hideAttribution: true }}
    >
      <Background gap={22} size={1} color="rgba(0,0,0,0.045)" />
      <Controls showInteractive={false} className="!overflow-hidden !rounded-[10px] !border-[color:var(--clyra-border)] !shadow-none" />
      {brain.sources.length >= 8 ? (
        <MiniMap
          pannable
          zoomable
          className="!border-[color:var(--clyra-border)] !bg-white !shadow-none"
          maskColor="rgba(28,28,28,0.05)"
          nodeColor={() => "#e8e8e6"}
        />
      ) : null}
    </ReactFlow>
  );
}

export function BrainCanvas(props: {
  brain: StudyBrain;
  processing: boolean;
  onBrainChange: (next: StudyBrain) => void;
  onAction: (action: BrainAction) => void;
  onSelectSource: (id: string | null) => void;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
