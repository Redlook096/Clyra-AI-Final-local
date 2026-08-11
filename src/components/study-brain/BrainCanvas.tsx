import {
  ConnectionMode,
  MiniMap,
  ReactFlow,
  ReactFlowProvider,
  addEdge,
  useReactFlow,
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

export type StudyCanvasApi = {
  zoomIn: () => void;
  zoomOut: () => void;
  fitView: () => void;
  center: () => void;
  focusNode: (id: string) => void;
};

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
  const connectedIds = brain.connections.length
    ? brain.connections
    : brain.sources.map((source) => source.id);
  const nodes: Node[] = [
    {
      id: "brain",
      type: "brain",
      position: brainPos,
      data: {
        title: brain.title,
        processing,
        connectedCount: connectedIds.length,
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
      data: { source: { ...source, connected: connectedIds.includes(source.id) } },
    });
  });
  const edges: Edge[] = connectedIds.map((sourceId) => {
    const sourcePos = brain.positions[sourceId] || brainPos;
    return {
      id: `e-${sourceId}-brain`,
      type: "step",
      source: sourceId,
      target: "brain",
      sourceHandle: facingSide(sourcePos, brainPos),
      targetHandle: facingSide(brainPos, sourcePos),
      animated: processing,
      style: EDGE_STYLE,
    } as Edge;
  });
  return { nodes, edges };
}

function CanvasInner({
  brain,
  processing,
  onBrainChange,
  onAction,
  onSelectSource,
  tool = "select",
  onCanvasApi,
  onConnectionDrop,
}: {
  brain: StudyBrain;
  processing: boolean;
  onBrainChange: (next: StudyBrain, recordHistory?: boolean) => void;
  onAction: (action: BrainAction) => void;
  onSelectSource: (id: string | null) => void;
  tool?: "select" | "pan" | "connect";
  onCanvasApi?: (api: StudyCanvasApi) => void;
  onConnectionDrop?: (position: { x: number; y: number }) => void;
}) {
  const { fitView, zoomIn, zoomOut, setCenter } = useReactFlow();
  const initial = useMemo(() => brainToFlow(brain, processing, onAction), []);
  const [nodes, setNodes, onNodesChange] = useNodesState(initial.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initial.edges);
  const brainRef = useRef(brain);
  brainRef.current = brain;
  const actionRef = useRef(onAction);
  actionRef.current = onAction;
  const connectingRef = useRef(false);

  useEffect(() => {
    const next = brainToFlow(brain, processing, (action) => actionRef.current(action));
    setNodes(next.nodes);
    setEdges(next.edges);
  }, [brain, processing, setNodes, setEdges]);

  // A newly added source can otherwise inherit the empty-space viewport and
  // land beyond the side panel. Fit only when the node count changes; manual
  // panning and dragging remain untouched afterwards.
  useEffect(() => {
    const frame = window.requestAnimationFrame(() => {
      void fitView({ padding: 0.2, duration: 220 });
    });
    return () => window.cancelAnimationFrame(frame);
  }, [brain.sources.length, fitView]);

  useEffect(() => {
    onCanvasApi?.({
      zoomIn: () => { void zoomIn({ duration: 160 }); },
      zoomOut: () => { void zoomOut({ duration: 160 }); },
      fitView: () => { void fitView({ padding: 0.2, duration: 180 }); },
      center: () => { void setCenter(brainRef.current.positions.brain?.x || 420, brainRef.current.positions.brain?.y || 280, { duration: 180 }); },
      focusNode: (id) => {
        const position = brainRef.current.positions[id];
        if (position) void setCenter(position.x + 100, position.y + 45, { zoom: 1, duration: 180 });
      },
    });
  }, [fitView, onCanvasApi, setCenter, zoomIn, zoomOut]);

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
            type: "step",
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
      defaultEdgeOptions={{ type: "step", style: EDGE_STYLE }}
      connectionMode={ConnectionMode.Loose}
      onNodesChange={(changes) => {
        onNodesChange(changes);
      }}
      onEdgesChange={onEdgesChange}
      onConnect={onConnect}
      onConnectStart={() => { connectingRef.current = true; }}
      onConnectEnd={(event, connectionState) => {
        if (connectingRef.current && !connectionState.isValid) {
          const pointer = event as MouseEvent | TouchEvent;
          const point = "touches" in pointer && pointer.touches[0]
            ? pointer.touches[0]
            : pointer as MouseEvent;
          onConnectionDrop?.({ x: point.clientX, y: point.clientY });
        }
        connectingRef.current = false;
      }}
      onNodeDragStop={(_event, _node, nextNodes) => persistLayout(nextNodes, edges)}
      onSelectionChange={({ nodes: selected }) => {
        const source = selected.find((node) => node.type === "source");
        onSelectSource(source?.id || null);
      }}
      onMoveEnd={(event, viewport) => {
        // React Flow also fires this after a programmatic fitView. That event
        // has no user gesture and can otherwise persist the previous node
        // snapshot while a newly imported source is being mounted.
        if (!event) {
          const current = brainRef.current;
          onBrainChange({ ...current, viewport, updatedAt: current.updatedAt }, false);
          return;
        }
        persistLayout(nodes, edges, viewport);
      }}
      fitView
      fitViewOptions={{ padding: 0.18 }}
      minZoom={0.35}
      maxZoom={1.6}
      panOnScroll
      panOnDrag={tool === "pan"}
      panActivationKeyCode="Space"
      nodesDraggable={tool !== "pan"}
      selectionOnDrag={tool === "select"}
      connectOnClick={tool === "connect"}
      className={`study-brain-flow study-brain-flow--${tool} bg-[color:var(--clyra-canvas)]`}
      proOptions={{ hideAttribution: true }}
    >
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
  onBrainChange: (next: StudyBrain, recordHistory?: boolean) => void;
  onAction: (action: BrainAction) => void;
  onSelectSource: (id: string | null) => void;
  tool?: "select" | "pan" | "connect";
  onCanvasApi?: (api: StudyCanvasApi) => void;
  onConnectionDrop?: (position: { x: number; y: number }) => void;
}) {
  return (
    <ReactFlowProvider>
      <CanvasInner {...props} />
    </ReactFlowProvider>
  );
}
