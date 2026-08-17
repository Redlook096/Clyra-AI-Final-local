import { useEffect, useRef } from "react";
import type { ForgeEntity, ForgeProject, ForgeRuntimeState } from "./model";

type ThreeTool = "select" | "move" | "rotate" | "scale";

function toWorld(entity: ForgeEntity) {
  return {
    x: (entity.transform.position.x - 640) / 70,
    y: Math.max(entity.size.y / 140, (600 - entity.transform.position.y) / 70),
    z: entity.transform.position.z / 20,
  };
}

function fromWorld(x: number, y: number, z: number) {
  return { x: x * 70 + 640, y: 600 - y * 70, z: z * 20 };
}

export function Forge3DViewport({
  project,
  selectedId,
  tool,
  runtime,
  onSelect,
  onTransform,
}: {
  project: ForgeProject;
  selectedId: string | null;
  tool: ThreeTool;
  runtime: ForgeRuntimeState;
  onSelect: (id: string | null) => void;
  onTransform: (id: string, transform: ForgeEntity["transform"]) => void;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const stateRef = useRef<{
    dispose: () => void;
    objects: Map<string, import("three").Object3D>;
    transform: import("three/addons/controls/TransformControls.js").TransformControls;
  } | null>(null);
  const scene = project.scenes.find((item) => item.id === project.activeSceneId) ?? project.scenes[0];
  const structureKey = scene.entities.map((entity) => `${entity.id}:${entity.kind}:${entity.visible}`).join("|");

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let cancelled = false;
    let cleanup = () => {};
    void Promise.all([
      import("three"),
      import("three/addons/controls/OrbitControls.js"),
      import("three/addons/controls/TransformControls.js"),
    ]).then(([THREE, { OrbitControls }, { TransformControls }]) => {
      if (cancelled) return;
      const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, alpha: false });
      renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.75));
      renderer.shadowMap.enabled = true;
      renderer.shadowMap.type = THREE.PCFSoftShadowMap;
      renderer.outputColorSpace = THREE.SRGBColorSpace;
      const threeScene = new THREE.Scene();
      threeScene.background = new THREE.Color(scene.background);
      threeScene.fog = new THREE.Fog(scene.background, 24, 80);
      const camera = new THREE.PerspectiveCamera(52, 1, .1, 240);
      camera.position.set(12, 10, 17);
      const orbit = new OrbitControls(camera, canvas);
      orbit.enableDamping = true;
      orbit.dampingFactor = .09;
      orbit.target.set(0, 1.2, 0);
      orbit.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      orbit.mouseButtons.MIDDLE = THREE.MOUSE.PAN;
      orbit.mouseButtons.RIGHT = THREE.MOUSE.PAN;
      threeScene.add(new THREE.HemisphereLight(0xeaf2ff, 0x18202a, 2.5));
      const key = new THREE.DirectionalLight(0xffffff, 3.1);
      key.position.set(9, 15, 8);
      key.castShadow = true;
      key.shadow.mapSize.set(1024, 1024);
      threeScene.add(key);
      const grid = new THREE.GridHelper(60, 60, 0x5d7288, 0x344457);
      grid.material.opacity = .36;
      grid.material.transparent = true;
      threeScene.add(grid);
      const objects = new Map<string, import("three").Object3D>();
      for (const entity of scene.entities) {
        if (!entity.visible || entity.kind === "camera") continue;
        if (entity.kind === "light") {
          const light = new THREE.PointLight(entity.color, 11, 16, 2);
          const world = toWorld(entity);
          light.position.set(world.x, Math.max(2, world.y), world.z);
          light.userData.entityId = entity.id;
          threeScene.add(light);
          objects.set(entity.id, light);
          continue;
        }
        const sx = Math.max(.35, entity.size.x / 70);
        const sy = Math.max(.35, entity.size.y / 70);
        const sz = Math.max(.35, entity.size.z / 70);
        const geometry = entity.kind === "enemy"
          ? new THREE.SphereGeometry(sx / 2, 24, 16)
          : entity.kind === "character"
            ? new THREE.CapsuleGeometry(Math.min(sx, sz) * .34, Math.max(.3, sy * .54), 6, 12)
            : new THREE.BoxGeometry(sx, sy, sz);
        const material = new THREE.MeshStandardMaterial({ color: entity.color, roughness: entity.kind === "enemy" ? .42 : .7, metalness: entity.kind === "enemy" ? .32 : .04 });
        const mesh = new THREE.Mesh(geometry, material);
        const world = toWorld(entity);
        mesh.position.set(world.x, world.y, world.z);
        mesh.rotation.set(entity.transform.rotation.x, entity.transform.rotation.y, entity.transform.rotation.z);
        mesh.scale.set(entity.transform.scale.x, entity.transform.scale.y, entity.transform.scale.z);
        mesh.castShadow = true;
        mesh.receiveShadow = true;
        mesh.userData.entityId = entity.id;
        threeScene.add(mesh);
        objects.set(entity.id, mesh);
      }
      const transform = new TransformControls(camera, canvas);
      transform.setSize(.82);
      transform.addEventListener("dragging-changed", (event) => { orbit.enabled = !event.value; });
      transform.addEventListener("objectChange", () => {
        const object = transform.object;
        const id = object?.userData.entityId as string | undefined;
        const source = scene.entities.find((entity) => entity.id === id);
        if (!object || !id || !source) return;
        const position = fromWorld(object.position.x, object.position.y, object.position.z);
        onTransform(id, {
          position,
          rotation: { x: object.rotation.x, y: object.rotation.y, z: object.rotation.z },
          scale: { x: object.scale.x, y: object.scale.y, z: object.scale.z },
        });
      });
      threeScene.add(transform.getHelper());
      const raycaster = new THREE.Raycaster();
      const pointer = new THREE.Vector2();
      const select = (event: PointerEvent) => {
        if (event.button !== 0 || transform.dragging) return;
        const rect = canvas.getBoundingClientRect();
        pointer.set((event.clientX - rect.left) / rect.width * 2 - 1, -((event.clientY - rect.top) / rect.height * 2 - 1));
        raycaster.setFromCamera(pointer, camera);
        const hit = raycaster.intersectObjects([...objects.values()], false).find((entry) => Boolean(entry.object.userData.entityId));
        onSelect((hit?.object.userData.entityId as string | undefined) ?? null);
      };
      canvas.addEventListener("pointerdown", select);
      let frame = 0;
      let previous = performance.now();
      const keys = new Set<string>();
      const keyDown = (event: KeyboardEvent) => keys.add(event.code);
      const keyUp = (event: KeyboardEvent) => keys.delete(event.code);
      window.addEventListener("keydown", keyDown);
      window.addEventListener("keyup", keyUp);
      const render = (time: number) => {
        const dt = Math.min((time - previous) / 1000, .05);
        previous = time;
        const player = objects.get("player");
        if (runtime === "playing" && player) {
          const dx = Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft"));
          const dz = Number(keys.has("KeyS") || keys.has("ArrowDown")) - Number(keys.has("KeyW") || keys.has("ArrowUp"));
          player.position.x += dx * 4.8 * dt;
          player.position.z += dz * 4.8 * dt;
        }
        const width = canvas.clientWidth;
        const height = canvas.clientHeight;
        if (canvas.width !== Math.floor(width * renderer.getPixelRatio()) || canvas.height !== Math.floor(height * renderer.getPixelRatio())) {
          renderer.setSize(width, height, false);
          camera.aspect = width / Math.max(1, height);
          camera.updateProjectionMatrix();
        }
        orbit.update();
        renderer.render(threeScene, camera);
        frame = requestAnimationFrame(render);
      };
      frame = requestAnimationFrame(render);
      cleanup = () => {
        cancelAnimationFrame(frame);
        canvas.removeEventListener("pointerdown", select);
        window.removeEventListener("keydown", keyDown);
        window.removeEventListener("keyup", keyUp);
        transform.dispose();
        orbit.dispose();
        for (const object of objects.values()) {
          if (object instanceof THREE.Mesh) {
            object.geometry.dispose();
            const material = object.material;
            if (Array.isArray(material)) material.forEach((item) => item.dispose()); else material.dispose();
          }
        }
        renderer.dispose();
      };
      stateRef.current = { dispose: cleanup, objects, transform };
    });
    return () => { cancelled = true; cleanup(); stateRef.current = null; };
  }, [scene.id, scene.background, structureKey]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    const object = selectedId ? state.objects.get(selectedId) : null;
    if (object && tool !== "select") {
      state.transform.attach(object);
      state.transform.setMode(tool);
    } else {
      state.transform.detach();
    }
  }, [selectedId, tool, structureKey]);

  useEffect(() => {
    const state = stateRef.current;
    if (!state) return;
    for (const entity of scene.entities) {
      const object = state.objects.get(entity.id);
      if (!object || state.transform.dragging && state.transform.object === object) continue;
      const world = toWorld(entity);
      object.position.set(world.x, world.y, world.z);
      object.rotation.set(entity.transform.rotation.x, entity.transform.rotation.y, entity.transform.rotation.z);
      object.scale.set(entity.transform.scale.x, entity.transform.scale.y, entity.transform.scale.z);
    }
  }, [scene.entities]);

  return <canvas ref={canvasRef} className="forge-viewport forge-viewport--three" aria-label={`${scene.name} 3D editor`} />;
}
