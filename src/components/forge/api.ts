import { api as vibeApi, type VibeProject } from "../clyra-code/api";
import type { ForgeSourceFile } from "./projectGenerator";

export type PersistedForgeProject = {
  project: VibeProject;
  files: ForgeSourceFile[];
};

export async function createPersistedForgeProject(
  name: string,
  prompt: string,
  files: ForgeSourceFile[],
  onFile?: (file: ForgeSourceFile, index: number) => void,
): Promise<PersistedForgeProject> {
  const project = await vibeApi.createProject(name, prompt);
  for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    await vibeApi.writeProjectFile(project.id, file.path, file.content);
    onFile?.(file, index);
  }
  return { project, files };
}

export async function saveForgeFile(projectId: string, file: ForgeSourceFile) {
  await vibeApi.writeProjectFile(projectId, file.path, file.content);
}

export async function loadForgeFiles(projectId: string) {
  const response = await vibeApi.getProject(projectId);
  return response.files;
}

export async function runForgeAgent(projectId: string, instruction: string) {
  await vibeApi.startRuntime(projectId);
  const session = await vibeApi.createSession(projectId, instruction.slice(0, 64) || "Forge change");
  await vibeApi.sendPrompt(projectId, session.id, `You are operating a Clyra Forge game project. Read GAME.md, ART_STYLE.json, src/scene.json and the existing runtime before editing. Implement this request in the real source and scene data: ${instruction}. Run the relevant build or validation before finishing. Do not claim visual inspection; use code, scene structure and runtime facts.`);
  return session;
}

export function forgeExportUrl(projectId: string) {
  return `/api/vibe/projects/${encodeURIComponent(projectId)}/export`;
}
