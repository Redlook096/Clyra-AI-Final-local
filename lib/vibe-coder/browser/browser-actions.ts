import { actOnManagedBrowser, type BrowserAction } from "../../openbrowser/browser-runtime";
import { AgentBrowserController } from "./agent-browser-controller";

export class BrowserActions {
  static async execute(action: BrowserAction, projectId?: string) {
    if (projectId) return AgentBrowserController.act(projectId, action);
    return actOnManagedBrowser(action);
  }
}
