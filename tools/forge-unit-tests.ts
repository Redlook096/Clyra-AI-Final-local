import assert from "node:assert/strict";
import { buildForgeSourceFiles, manifestFromPrompt } from "../src/components/forge/projectGenerator";
import { createStarterProject } from "../src/components/forge/model";

let assertions = 0;
const twoD = manifestFromPrompt("Create a 2D cyberpunk platformer with wall-running and drones", "2d");
assert.equal(twoD.mode, "2d"); assertions += 1;
assert(twoD.mechanics.some((item) => /wall/i.test(item))); assertions += 1;
const twoDFiles = buildForgeSourceFiles(createStarterProject("Create a 2D cyberpunk platformer with wall-running and drones", "2d"), "Create a 2D cyberpunk platformer with wall-running and drones", twoD);
assert(twoDFiles.some((file) => file.path === "src/main.ts" && file.content.includes("@dimforge/rapier2d-compat"))); assertions += 1;
assert(twoDFiles.some((file) => file.path === "GAME.md" && file.content.includes("Core loop"))); assertions += 1;

const threeD = manifestFromPrompt("Build a third-person low-poly horror game in an abandoned hospital", "3d");
assert.equal(threeD.mode, "3d"); assertions += 1;
const threeDFiles = buildForgeSourceFiles(createStarterProject("Build a third-person low-poly horror game in an abandoned hospital", "3d"), "Build a third-person low-poly horror game in an abandoned hospital", threeD);
assert(threeDFiles.some((file) => file.path === "src/main.ts" && file.content.includes("THREE.PerspectiveCamera"))); assertions += 1;
assert(threeDFiles.some((file) => file.path === "src/scene.json" && file.content.includes("Nurse_Enemy"))); assertions += 1;
assert(threeDFiles.some((file) => file.path === "ART_STYLE.json")); assertions += 1;

console.log(`forge-unit-tests: ${assertions} assertions passed`);
