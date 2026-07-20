import {
  actOnManagedBrowser,
  cancelManagedBrowserAgent,
  getManagedBrowserAgentSession,
  getManagedBrowserObservation,
  getManagedBrowserState,
  navigateManagedBrowser,
  runManagedBrowserAgent,
  setManagedBrowserAgentControl,
  type BrowserAction,
  type BrowserAgentEvent,
} from "../../openbrowser/browser-runtime";

export type VibeBrowserSession = {
  projectId: string;
  threadId?: string;
  url: string;
  startedAt: string;
  actionCount: number;
  lastObservationAt?: string;
};

/**
 * The Vibe façade deliberately delegates to Clyra's one managed Playwright
 * browser. It keeps the preview and automation in the same real session.
 */
export class AgentBrowserController {
  private static sessions = new Map<string, VibeBrowserSession>();

  static async startSession(url: string, input: { projectId?: string; threadId?: string } = {}) {
    const projectId = input.projectId || "default";
    await navigateManagedBrowser(url);
    const state = await getManagedBrowserState();
    const session: VibeBrowserSession = {
      projectId,
      threadId: input.threadId,
      url: state.url,
      startedAt: new Date().toISOString(),
      actionCount: 0,
    };
    this.sessions.set(projectId, session);
    return { session, state, observation: await this.observeState(projectId) };
  }

  static async observeState(projectId = "default") {
    const observation = await getManagedBrowserObservation();
    const session = this.sessions.get(projectId);
    if (session) {
      session.url = observation.page.url;
      session.lastObservationAt = new Date().toISOString();
    }
    return observation;
  }

  static async act(projectId: string, action: BrowserAction) {
    const result = await actOnManagedBrowser(action);
    const session = this.sessions.get(projectId);
    if (session) {
      session.url = result.state.url;
      session.actionCount += 1;
      session.lastObservationAt = new Date().toISOString();
    }
    return result;
  }

  static async runTask(projectId: string, task: string, apiKey: string, onEvent?: (event: BrowserAgentEvent) => void) {
    const result = await runManagedBrowserAgent(task, apiKey, { onEvent });
    const session = this.sessions.get(projectId);
    if (session) session.url = result.state.url;
    return result;
  }

  static async state(projectId = "default") {
    return { session: this.sessions.get(projectId) || null, browser: await getManagedBrowserState(), agent: await getManagedBrowserAgentSession() };
  }

  static pause() { return setManagedBrowserAgentControl("pause"); }
  static resume() { return setManagedBrowserAgentControl("resume"); }
  static takeControl() { return setManagedBrowserAgentControl("take_control"); }
  static returnControl() { return setManagedBrowserAgentControl("return_control"); }
  static stopSession() { cancelManagedBrowserAgent(); }
}
