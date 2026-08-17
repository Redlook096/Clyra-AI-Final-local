import type { ForgeMode, ForgeProject } from "./model";

export type ForgeSourceFile = { path: string; content: string };

export type ForgeBuildManifest = {
  title: string;
  mode: ForgeMode;
  genre: string;
  coreLoop: string;
  mechanics: string[];
  artStyle: string;
};

function titleFromPrompt(prompt: string) {
  const cleaned = prompt
    .replace(/^(?:create|build|make)\s+(?:me\s+)?(?:a|an)\s+/i, "")
    .replace(/[.!?]+$/g, "")
    .trim();
  const words = cleaned.split(/\s+/).filter(Boolean).slice(0, 4);
  return words.length ? words.map((word) => word[0]?.toUpperCase() + word.slice(1)).join(" ") : "Untitled World";
}

export function manifestFromPrompt(prompt: string, requestedMode: ForgeMode): ForgeBuildManifest {
  const lower = prompt.toLowerCase();
  const mode: ForgeMode = /\b3d\b|first.person|third.person|horror|driving|village|hospital/.test(lower) ? "3d" : requestedMode;
  const genre = /horror/.test(lower) ? "Horror" : /rpg|role.play/.test(lower) ? "RPG" : /top.down/.test(lower) ? "Top-down action" : /platform/.test(lower) ? "Platformer" : /driv/.test(lower) ? "Driving" : mode === "3d" ? "Exploration" : "Action";
  const mechanics = [
    /wall.?run/.test(lower) ? "Wall running" : mode === "2d" ? "Responsive movement" : "Third-person movement",
    /drone|enemy|combat|shoot/.test(lower) ? "Enemy encounters" : "Environmental interaction",
    /multiplayer|four players|co.?op/.test(lower) ? "Multiplayer-ready player state" : "Checkpoint progression",
  ];
  return {
    title: titleFromPrompt(prompt),
    mode,
    genre,
    coreLoop: mode === "2d" ? "Traverse, avoid hazards, reach the checkpoint" : "Explore, interact, complete the objective",
    mechanics,
    artStyle: /cyber|neon/.test(lower) ? "low-poly cyberpunk" : /horror|abandoned/.test(lower) ? "restrained low-poly horror" : /coast|ocean/.test(lower) ? "soft low-poly coastal" : "stylised geometric",
  };
}

function gameMd(manifest: ForgeBuildManifest, prompt: string) {
  return `# ${manifest.title}

## Concept
${prompt}

## Genre
${manifest.genre} · ${manifest.mode.toUpperCase()}

## Core loop
${manifest.coreLoop}.

## Controls
- Move: WASD / arrow keys
- Jump or primary action: Space
- Pause: Escape

## Mechanics
${manifest.mechanics.map((item) => `- ${item}`).join("\n")}

## Art style
${manifest.artStyle}. Assets are generated from editable geometry and vector recipes.

## Architecture
Entity/component scene JSON is canonical. The runtime, editor and Clyra tools read and write the same scene graph.
`;
}

function runtime2d() {
  return `import { Application, Container, Graphics, Text } from "pixi.js";
import RAPIER from "@dimforge/rapier2d-compat";
import scene from "./scene.json";

await RAPIER.init();
const app = new Application();
await app.init({ resizeTo: window, antialias: true, background: scene.background });
document.querySelector("#game")!.appendChild(app.canvas);

const world = new RAPIER.World({ x: 0, y: 900 });
const root = new Container();
app.stage.addChild(root);
const bodies = new Map<string, RAPIER.RigidBody>();
const graphics = new Map<string, Graphics>();

for (const entity of scene.entities) {
  if (!entity.visible || entity.kind === "camera") continue;
  const body = world.createRigidBody(
    entity.kind === "character"
      ? RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(entity.transform.position.x, entity.transform.position.y)
      : RAPIER.RigidBodyDesc.fixed().setTranslation(entity.transform.position.x, entity.transform.position.y),
  );
  world.createCollider(RAPIER.ColliderDesc.cuboid(entity.size.x / 2, entity.size.y / 2), body);
  const graphic = new Graphics().roundRect(-entity.size.x / 2, -entity.size.y / 2, entity.size.x, entity.size.y, Math.min(14, entity.size.y / 3)).fill(entity.color);
  graphic.position.set(entity.transform.position.x, entity.transform.position.y);
  root.addChild(graphic);
  bodies.set(entity.id, body);
  graphics.set(entity.id, graphic);
}

const player = bodies.get("player");
const keys = new Set<string>();
addEventListener("keydown", (event) => keys.add(event.code));
addEventListener("keyup", (event) => keys.delete(event.code));
const status = new Text({ text: scene.name, style: { fill: 0xffffff, fontFamily: "system-ui", fontSize: 14 } });
status.position.set(18, 16); app.stage.addChild(status);

app.ticker.add((ticker) => {
  if (!player) return;
  const dt = Math.min(ticker.deltaMS / 1000, 1 / 20);
  const position = player.translation();
  const direction = Number(keys.has("KeyD") || keys.has("ArrowRight")) - Number(keys.has("KeyA") || keys.has("ArrowLeft"));
  const vertical = Number(keys.has("KeyS") || keys.has("ArrowDown")) - Number(keys.has("KeyW") || keys.has("ArrowUp"));
  player.setNextKinematicTranslation({ x: position.x + direction * 260 * dt, y: position.y + vertical * 180 * dt });
  world.step();
  for (const [id, body] of bodies) {
    const point = body.translation();
    graphics.get(id)?.position.set(point.x, point.y);
  }
});
`;
}

function runtime3d() {
  return `import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";
import RAPIER from "@dimforge/rapier3d-compat";
import sceneData from "./scene.json";

await RAPIER.init();
const canvas = document.querySelector<HTMLCanvasElement>("#game")!;
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
const scene = new THREE.Scene();
scene.background = new THREE.Color(sceneData.background);
scene.fog = new THREE.Fog(sceneData.background, 20, 90);
const camera = new THREE.PerspectiveCamera(55, 1, .1, 300);
camera.position.set(12, 10, 18);
const controls = new OrbitControls(camera, renderer.domElement);
controls.target.set(0, 1.5, 0); controls.enableDamping = true;
scene.add(new THREE.HemisphereLight(0xdcecff, 0x17202a, 2.2));
const sun = new THREE.DirectionalLight(0xffffff, 2.8); sun.position.set(8, 14, 5); sun.castShadow = true; scene.add(sun);
const world = new RAPIER.World({ x: 0, y: -9.81, z: 0 });
const meshes = new Map<string, THREE.Mesh>();
const bodies = new Map<string, RAPIER.RigidBody>();

for (const entity of sceneData.entities) {
  if (!entity.visible || entity.kind === "camera" || entity.kind === "light") continue;
  const size = { x: Math.max(.3, entity.size.x / 70), y: Math.max(.3, entity.size.y / 70), z: Math.max(.3, entity.size.z / 70) };
  const geometry = entity.kind === "enemy" ? new THREE.SphereGeometry(size.x / 2, 24, 14) : new THREE.BoxGeometry(size.x, size.y, size.z);
  const mesh = new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({ color: entity.color, roughness: .68, metalness: entity.kind === "enemy" ? .35 : .05 }));
  const x = (entity.transform.position.x - 640) / 70, y = Math.max(size.y / 2, (600 - entity.transform.position.y) / 70), z = entity.transform.position.z / 20;
  mesh.position.set(x, y, z); mesh.castShadow = true; mesh.receiveShadow = true; mesh.userData.entityId = entity.id; scene.add(mesh); meshes.set(entity.id, mesh);
  const body = world.createRigidBody(entity.kind === "character" ? RAPIER.RigidBodyDesc.kinematicVelocityBased().setTranslation(x, y, z) : RAPIER.RigidBodyDesc.fixed().setTranslation(x, y, z));
  world.createCollider(RAPIER.ColliderDesc.cuboid(size.x / 2, size.y / 2, size.z / 2), body); bodies.set(entity.id, body);
}

const keys = new Set<string>(); addEventListener("keydown", (event) => keys.add(event.code)); addEventListener("keyup", (event) => keys.delete(event.code));
function resize() { const width = canvas.clientWidth, height = canvas.clientHeight; renderer.setSize(width, height, false); camera.aspect = width / Math.max(1, height); camera.updateProjectionMatrix(); }
renderer.setAnimationLoop((_time) => { resize(); const player = bodies.get("player"); if (player) { const p = player.translation(); const dx = Number(keys.has("KeyD")) - Number(keys.has("KeyA")); const dz = Number(keys.has("KeyS")) - Number(keys.has("KeyW")); player.setNextKinematicTranslation({ x: p.x + dx * .07, y: p.y, z: p.z + dz * .07 }); } world.step(); for (const [id, body] of bodies) { const p = body.translation(); meshes.get(id)?.position.set(p.x, p.y, p.z); } controls.update(); renderer.render(scene, camera); });
`;
}

export function buildForgeSourceFiles(project: ForgeProject, prompt: string, manifest = manifestFromPrompt(prompt, project.mode)): ForgeSourceFile[] {
  const scene = project.scenes.find((item) => item.id === project.activeSceneId) ?? project.scenes[0];
  const packageJson = {
    name: project.name.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "clyra-forge-game",
    private: true,
    version: "0.1.0",
    type: "module",
    scripts: { dev: "vite", build: "vite build", preview: "vite preview" },
    dependencies: project.mode === "3d"
      ? { "@dimforge/rapier3d-compat": "^0.18.0", three: "^0.185.0" }
      : { "@dimforge/rapier2d-compat": "^0.18.0", "pixi.js": "^8.19.0" },
    devDependencies: { typescript: "^5.8.2", vite: "^6.2.0" },
  };
  const artStyle = {
    style: project.artStyle.name,
    palette: { primary: project.artStyle.primary, secondary: project.artStyle.secondary, accent: project.artStyle.accent },
    geometry: { edgeStyle: "clean", detailLevel: "medium", bevelScale: 0.04 },
    lighting: { contrast: "medium", accentLights: project.artStyle.accent },
  };
  return [
    { path: "package.json", content: JSON.stringify(packageJson, null, 2) },
    { path: "index.html", content: `<!doctype html><html><head><meta charset="UTF-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${project.name}</title><style>html,body,#game{width:100%;height:100%;margin:0;overflow:hidden}body{background:${scene.background};font-family:system-ui}canvas{display:block;width:100%;height:100%}</style></head><body><div id="game"></div><script type="module" src="/src/main.ts"></script></body></html>` },
    { path: "src/main.ts", content: project.mode === "3d" ? runtime3d() : runtime2d() },
    { path: "src/scene.json", content: JSON.stringify(scene, null, 2) },
    { path: "GAME.md", content: gameMd(manifest, prompt) },
    { path: "ART_STYLE.json", content: JSON.stringify(artStyle, null, 2) },
    { path: "FORGE_PLAN.md", content: `# First playable\n\n- [x] Project architecture\n- [x] ${manifest.mode.toUpperCase()} runtime\n- [x] Player controls\n- [x] Editable semantic scene\n- [x] Structured validation\n- [ ] Expand mechanics through Clyra\n` },
    { path: "README.md", content: `# ${project.name}\n\nGenerated by Clyra Forge as a real editable ${manifest.mode.toUpperCase()} source project.\n\n\`\`\`sh\nnpm install\nnpm run dev\n\`\`\`\n` },
  ];
}
