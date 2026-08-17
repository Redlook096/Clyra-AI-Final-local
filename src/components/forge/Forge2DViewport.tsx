import { useEffect, useRef } from "react";
import type { ForgeEntity, ForgeProject, ForgeRuntimeState } from "./model";

export function Forge2DViewport({
  project,
  selectedId,
  runtime,
  onSelect,
  onMove,
}: {
  project: ForgeProject;
  selectedId: string | null;
  runtime: ForgeRuntimeState;
  onSelect: (id: string | null) => void;
  onMove: (id: string, x: number, y: number) => void;
}) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const scene = project.scenes.find((item) => item.id === project.activeSceneId) ?? project.scenes[0];
  const structureKey = scene.entities.map((entity) => `${entity.id}:${entity.kind}:${entity.visible}:${entity.color}`).join("|");
  const dragRef = useRef<{ id: string; offsetX: number; offsetY: number } | null>(null);
  const graphicsRef = useRef(new Map<string, import("pixi.js").Graphics>());

  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    let cancelled = false;
    let cleanup = () => {};
    void import("pixi.js").then(async ({ Application, Container, Graphics }) => {
      if (cancelled) return;
      const app = new Application();
      await app.init({ resizeTo: host, antialias: true, background: scene.background, resolution: Math.min(devicePixelRatio || 1, 1.75), autoDensity: true });
      if (cancelled) { app.destroy(true); return; }
      host.replaceChildren(app.canvas);
      const root = new Container();
      root.scale.set(Math.min(host.clientWidth / scene.width, host.clientHeight / scene.height));
      root.position.set((host.clientWidth - scene.width * root.scale.x) / 2, (host.clientHeight - scene.height * root.scale.y) / 2);
      app.stage.addChild(root);
      const grid = new Graphics();
      for (let x = 0; x <= scene.width; x += 32) grid.moveTo(x, 0).lineTo(x, scene.height);
      for (let y = 0; y <= scene.height; y += 32) grid.moveTo(0, y).lineTo(scene.width, y);
      grid.stroke({ color: 0xffffff, alpha: .055, width: 1 });
      root.addChild(grid);
      const graphics = new Map<string, import("pixi.js").Graphics>();
      for (const entity of scene.entities) {
        if (!entity.visible || entity.kind === "camera") continue;
        const shape = new Graphics();
        if (entity.kind === "enemy") shape.ellipse(0, 0, entity.size.x / 2, entity.size.y / 2).fill(entity.color).circle(0, 0, 5).fill(0xeaf4ff);
        else if (entity.kind === "light") shape.circle(0, 0, entity.size.x / 2).fill(entity.color);
        else if (entity.kind === "trigger") shape.roundRect(-entity.size.x / 2, -entity.size.y / 2, entity.size.x, entity.size.y, 7).fill({ color: entity.color, alpha: .12 }).stroke({ color: entity.color, width: 3, alpha: .9 });
        else shape.roundRect(-entity.size.x / 2, -entity.size.y / 2, entity.size.x, entity.size.y, entity.kind === "character" ? 14 : 7).fill(entity.color);
        shape.position.set(entity.transform.position.x, entity.transform.position.y);
        shape.eventMode = "static";
        shape.cursor = "pointer";
        shape.on("pointerdown", (event) => {
          event.stopPropagation();
          onSelect(entity.id);
          if (runtime === "stopped" && !entity.locked) {
            const local = event.getLocalPosition(root);
            dragRef.current = { id: entity.id, offsetX: local.x - shape.x, offsetY: local.y - shape.y };
          }
        });
        root.addChild(shape);
        graphics.set(entity.id, shape);
      }
      app.stage.eventMode = "static";
      app.stage.hitArea = app.screen;
      app.stage.on("pointerdown", () => onSelect(null));
      app.stage.on("pointermove", (event) => {
        const drag = dragRef.current;
        if (!drag) return;
        const local = event.getLocalPosition(root);
        onMove(drag.id, Math.round((local.x - drag.offsetX) / 8) * 8, Math.round((local.y - drag.offsetY) / 8) * 8);
      });
      app.stage.on("pointerup", () => { dragRef.current = null; });
      app.stage.on("pointerupoutside", () => { dragRef.current = null; });
      graphicsRef.current = graphics;
      const keys = new Set<string>();
      const keyDown = (event: KeyboardEvent) => keys.add(event.code);
      const keyUp = (event: KeyboardEvent) => keys.delete(event.code);
      addEventListener("keydown", keyDown); addEventListener("keyup", keyUp);
      app.ticker.add((ticker) => {
        if (runtime !== "playing") return;
        const player = graphics.get("player");
        if (!player) return;
        const dt = Math.min(ticker.deltaMS / 1000, .05);
        player.x += (Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft"))) * 260 * dt;
        player.y += (Number(keys.has("KeyS") || keys.has("ArrowDown")) - Number(keys.has("KeyW") || keys.has("ArrowUp"))) * 180 * dt;
      });
      cleanup = () => { removeEventListener("keydown", keyDown); removeEventListener("keyup", keyUp); graphicsRef.current.clear(); app.destroy(true, { children: true }); };
    });
    return () => { cancelled = true; cleanup(); };
  }, [scene.id, scene.background, structureKey]);

  useEffect(() => {
    for (const entity of scene.entities) {
      const graphic = graphicsRef.current.get(entity.id);
      if (!graphic || dragRef.current?.id === entity.id || runtime === "playing" && entity.id === "player") continue;
      graphic.position.set(entity.transform.position.x, entity.transform.position.y);
      graphic.alpha = entity.id === selectedId ? 1 : .94;
      graphic.tint = entity.id === selectedId ? 0xeaf3ff : 0xffffff;
    }
  }, [scene.entities, selectedId, runtime]);

  return <div ref={hostRef} className="forge-viewport forge-viewport--pixi" aria-label={`${scene.name} 2D editor`} />;
}
