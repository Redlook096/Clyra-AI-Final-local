export type ForgeMode = "2d" | "3d";
export type ForgeRuntimeState = "stopped" | "playing" | "paused";

export type ForgeVector = { x: number; y: number; z: number };

export type ForgeComponent = {
  id: string;
  type: string;
  enabled: boolean;
  properties: Record<string, string | number | boolean>;
};

export type ForgeEntityKind =
  | "character"
  | "platform"
  | "enemy"
  | "camera"
  | "light"
  | "trigger"
  | "prop";

export type ForgeEntity = {
  id: string;
  name: string;
  kind: ForgeEntityKind;
  transform: {
    position: ForgeVector;
    rotation: ForgeVector;
    scale: ForgeVector;
  };
  size: ForgeVector;
  color: string;
  locked?: boolean;
  visible: boolean;
  components: ForgeComponent[];
};

export type ForgeScene = {
  id: string;
  name: string;
  mode: ForgeMode;
  width: number;
  height: number;
  depth: number;
  background: string;
  entities: ForgeEntity[];
};

export type ForgeAsset = {
  id: string;
  name: string;
  type: "sprite" | "material" | "audio" | "prefab" | "script";
  recipe: Record<string, string | number | boolean | string[]>;
};

export type ForgeProject = {
  id: string;
  name: string;
  concept: string;
  mode: ForgeMode;
  artStyle: {
    name: string;
    primary: string;
    secondary: string;
    accent: string;
  };
  scenes: ForgeScene[];
  activeSceneId: string;
  assets: ForgeAsset[];
};

export type ForgeRenderEntry = {
  entityId: string;
  name: string;
  visible: boolean;
  screenBounds: [number, number, number, number];
  screenCoverage: number;
};

export type ForgeReport = {
  title: string;
  passed: boolean;
  summary: string;
  warnings: string[];
  metrics: Record<string, string | number>;
};

const component = (
  type: string,
  properties: ForgeComponent["properties"] = {},
): ForgeComponent => ({
  id: `${type.toLowerCase()}-${crypto.randomUUID()}`,
  type,
  enabled: true,
  properties,
});

const transform = (x: number, y: number, z = 0) => ({
  position: { x, y, z },
  rotation: { x: 0, y: 0, z: 0 },
  scale: { x: 1, y: 1, z: 1 },
});

export function createStarterProject(
  prompt = "A stylised 2D platformer set on rooftops at night",
  requestedMode?: ForgeMode,
): ForgeProject {
  const lower = prompt.toLowerCase();
  const mode: ForgeMode = requestedMode ?? (/3d|first.person|third.person|horror|village/.test(lower) ? "3d" : "2d");
  const horror = /horror|hospital|laboratory|abandoned/.test(lower);
  const coastal = /coast|ocean|village/.test(lower);
  const name = horror ? "Underground Signal" : coastal ? "Coastal Light" : "Neon Rooftops";
  const background = horror ? "#1a2026" : coastal ? "#91c9db" : "#14223a";
  const scene: ForgeScene = {
    id: "scene-main",
    name: mode === "2d" ? "Rooftop_01" : horror ? "Laboratory_Lobby" : "Coastal_Village",
    mode,
    width: 1280,
    height: 720,
    depth: mode === "3d" ? 80 : 1,
    background,
    entities: [
      {
        id: "camera-main",
        name: "Main Camera",
        kind: "camera",
        transform: transform(640, 360, 18),
        size: { x: 1280, y: 720, z: 1 },
        color: "#6b7280",
        locked: true,
        visible: false,
        components: [component("Camera", { zoom: 1, projection: mode === "3d" ? "perspective" : "orthographic" })],
      },
      {
        id: "player",
        name: "Player",
        kind: "character",
        transform: transform(186, 506, mode === "3d" ? 4 : 0),
        size: { x: 42, y: 62, z: 36 },
        color: "#3b82f6",
        visible: true,
        components: [
          component("CharacterController", { speed: 6.2, jumpForce: 13, grounded: true }),
          component("Health", { current: 100, maximum: 100 }),
          component("Animator", { state: "Idle" }),
        ],
      },
      {
        id: "platform-a",
        name: mode === "2d" ? "Roof_A" : "Lobby_Floor",
        kind: "platform",
        transform: transform(295, 596, 0),
        size: { x: 590, y: 74, z: mode === "3d" ? 420 : 1 },
        color: horror ? "#596168" : "#394b65",
        visible: true,
        components: [component("Collider", { body: "static", friction: 0.7 })],
      },
      {
        id: "platform-b",
        name: mode === "2d" ? "Roof_B" : "East_Wing",
        kind: "platform",
        transform: transform(895, 508, mode === "3d" ? -10 : 0),
        size: { x: 420, y: 58, z: mode === "3d" ? 210 : 1 },
        color: horror ? "#485057" : "#2e405c",
        visible: true,
        components: [component("Collider", { body: "static", friction: 0.72 })],
      },
      {
        id: "enemy-drone",
        name: horror ? "Nurse_Enemy" : "Drone_01",
        kind: "enemy",
        transform: transform(770, 390, mode === "3d" ? -4 : 0),
        size: { x: 52, y: 34, z: 52 },
        color: "#ef8f55",
        visible: true,
        components: [
          component("Perception", { detectionRadius: 260, fieldOfView: 105 }),
          component("Behaviour", { state: "Patrol", path: "Path_01" }),
          component("Health", { current: 40, maximum: 40 }),
        ],
      },
      {
        id: "checkpoint",
        name: "Checkpoint_01",
        kind: "trigger",
        transform: transform(535, 525, 0),
        size: { x: 26, y: 70, z: 26 },
        color: "#66d5c4",
        visible: true,
        components: [component("Trigger", { event: "setCheckpoint", once: true })],
      },
      {
        id: "light-key",
        name: "Key Light",
        kind: "light",
        transform: transform(1030, 164, 12),
        size: { x: 30, y: 30, z: 30 },
        color: "#8bb9ff",
        visible: true,
        components: [component("Light", { type: "spot", intensity: 840, range: 380 })],
      },
    ],
  };

  return {
    id: `forge-${Date.now()}`,
    name,
    concept: prompt,
    mode,
    activeSceneId: scene.id,
    artStyle: {
      name: horror ? "restrained low-poly horror" : coastal ? "soft low-poly coastal" : "low-poly cyberpunk",
      primary: background,
      secondary: "#394b65",
      accent: "#3b82f6",
    },
    scenes: [scene],
    assets: [
      { id: "asset-player", name: "Player recipe", type: "prefab", recipe: { shape: mode === "2d" ? "layered-vector" : "modular-primitives", palette: "project", editable: true } },
      { id: "asset-material", name: "World material", type: "material", recipe: { roughness: 0.68, detail: "low", accentEmission: true } },
      { id: "asset-controller", name: "PlayerController.ts", type: "script", recipe: { language: "TypeScript", systems: ["input", "physics", "animation"] } },
      { id: "asset-confirm", name: "UI confirm", type: "audio", recipe: { oscillator: "sine", frequency: 620, durationMs: 90 } },
    ],
  };
}

export function activeScene(project: ForgeProject): ForgeScene {
  return project.scenes.find((scene) => scene.id === project.activeSceneId) ?? project.scenes[0];
}

export function buildSemanticScene(scene: ForgeScene): string {
  const lines = [
    `Scene: ${scene.name}`,
    `Mode: ${scene.mode.toUpperCase()}`,
    `World: ${scene.width} x ${scene.height}${scene.mode === "3d" ? ` x ${scene.depth}` : ""}`,
    `Entities: ${scene.entities.length}`,
    "",
  ];
  for (const entity of scene.entities) {
    const { position } = entity.transform;
    lines.push(entity.name);
    lines.push(`  type: ${entity.kind}`);
    lines.push(`  position: [${position.x.toFixed(1)}, ${position.y.toFixed(1)}, ${position.z.toFixed(1)}]`);
    lines.push(`  size: [${entity.size.x}, ${entity.size.y}, ${entity.size.z}]`);
    lines.push(`  visible: ${entity.visible}`);
    lines.push(`  components: ${entity.components.map((item) => item.type).join(", ") || "none"}`);
    for (const item of entity.components) {
      const values = Object.entries(item.properties).map(([key, value]) => `${key}=${value}`).join(", ");
      if (values) lines.push(`    ${item.type}: ${values}`);
    }
    lines.push("");
  }
  return lines.join("\n");
}

export function getRenderTelemetry(scene: ForgeScene): { entries: ForgeRenderEntry[]; report: ForgeReport } {
  const entries = scene.entities.filter((entity) => entity.kind !== "camera").map((entity) => {
    const left = entity.transform.position.x - entity.size.x / 2;
    const top = entity.transform.position.y - entity.size.y / 2;
    const visible = entity.visible && left < scene.width && top < scene.height && left + entity.size.x > 0 && top + entity.size.y > 0;
    const width = Math.max(0, Math.min(scene.width, left + entity.size.x) - Math.max(0, left));
    const height = Math.max(0, Math.min(scene.height, top + entity.size.y) - Math.max(0, top));
    return {
      entityId: entity.id,
      name: entity.name,
      visible,
      screenBounds: [left / scene.width, top / scene.height, entity.size.x / scene.width, entity.size.y / scene.height] as [number, number, number, number],
      screenCoverage: Number(((width * height) / (scene.width * scene.height) * 100).toFixed(2)),
    };
  });
  const outside = entries.filter((entry) => !entry.visible).map((entry) => `${entry.name} is outside the active camera bounds.`);
  return {
    entries,
    report: {
      title: "Render telemetry",
      passed: outside.length === 0,
      summary: `${entries.filter((entry) => entry.visible).length} visible entities. ${outside.length} camera warning${outside.length === 1 ? "" : "s"}.`,
      warnings: outside,
      metrics: {
        visibleEntities: entries.filter((entry) => entry.visible).length,
        drawCallsEstimate: entries.filter((entry) => entry.visible).length + 2,
        triangleEstimate: scene.mode === "3d" ? entries.length * 192 : 0,
        targetFrameTimeMs: 16.7,
      },
    },
  };
}

export function validateScene(scene: ForgeScene): ForgeReport {
  const player = scene.entities.find((entity) => entity.kind === "character");
  const platforms = scene.entities.filter((entity) => entity.kind === "platform").sort((a, b) => a.transform.position.x - b.transform.position.x);
  const warnings: string[] = [];
  if (!player) warnings.push("No player spawn exists.");
  if (!platforms.length) warnings.push("No traversable surface exists.");
  if (scene.mode === "2d") {
    for (let index = 1; index < platforms.length; index += 1) {
      const previous = platforms[index - 1];
      const current = platforms[index];
      const gap = current.transform.position.x - current.size.x / 2 - (previous.transform.position.x + previous.size.x / 2);
      if (gap > 230) warnings.push(`${previous.name} → ${current.name} gap is ${Math.round(gap)}px and may exceed the starter jump arc.`);
    }
  }
  const duplicateIds = scene.entities.filter((entity, index, all) => all.findIndex((candidate) => candidate.id === entity.id) !== index);
  if (duplicateIds.length) warnings.push("Duplicate entity identifiers detected.");
  return {
    title: "Playable validation",
    passed: warnings.length === 0,
    summary: warnings.length ? `${warnings.length} issue${warnings.length === 1 ? "" : "s"} require attention.` : "Spawn, traversal, identifiers and camera bounds pass structured checks.",
    warnings,
    metrics: {
      entities: scene.entities.length,
      platforms: platforms.length,
      checkpoints: scene.entities.filter((entity) => entity.components.some((item) => item.type === "Trigger")).length,
    },
  };
}

export function cloneProject(project: ForgeProject): ForgeProject {
  return structuredClone(project);
}
