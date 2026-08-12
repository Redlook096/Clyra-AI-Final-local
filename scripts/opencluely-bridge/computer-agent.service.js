/**
 * OpenCluely Take Control — powered by 777genius/os-ai-computer-use architecture.
 * Uses Anthropic Computer Use API when ANTHROPIC_API_KEY is set; falls back to
 * Clyra Gemini vision + os-ai-computer-use orchestrator otherwise.
 *
 * Reference: https://github.com/777genius/os-ai-computer-use (Apache-2.0)
 */
const { screen } = require('electron');
// This service is copied to the Electron app root (not src/services).
const logger = require('./src/core/logger').createServiceLogger('COMPUTER-AGENT');
const { BashExecutor } = require('./computer-agent-bash');
const { safetyPromptRules } = require('./src/services/control-safety');
const { OsAiComputerUseOrchestrator } = require('./os-ai-computer-use.service');

const MAX_ITERATIONS = 50;
const AI_WIDTH = 1280;
const AI_HEIGHT = 800;

class ComputerAgentService {
  constructor(deps) {
    this.deps = deps;
    this.running = false;
    this.abort = false;
    this.bash = new BashExecutor();
    // This is the usable baseline before the optional Computer Use provider is
    // checked. It keeps status truthful on a fresh launch instead of showing
    // an ambiguous "unknown" engine.
    this.engine = 'os-ai-computer-use';
    this.abortController = null;
    this.runId = 0;
  }

  status() {
    return {
      engine: this.engine,
      running: this.running,
      anthropicConfigured: Boolean(process.env.ANTHROPIC_API_KEY || process.env.CLYRA_ANTHROPIC_API_KEY),
      apiProxy: String(process.env.CLYRA_COMPUTER_AGENT_API_URL || process.env.CLYRA_API_BASE || '').trim() || null,
      reference: 'https://github.com/777genius/os-ai-computer-use',
    };
  }

  stop() {
    this.abort = true;
    this.running = false;
    this.abortController?.abort();
  }

  #emit(patch) {
    const { windowManager } = this.deps;
    windowManager?.broadcastToAllWindows?.('control-status', patch);
  }

  async #captureJpegBase64(softCloak) {
    const { captureService, desktopControl, softCloakFn } = this.deps;
    try {
      desktopControl?.hideAICursor?.();
      if (softCloakFn) softCloakFn(true);
      await new Promise((r) => setTimeout(r, 120));
      const capture = await captureService.captureForComputerAgent({ fullScreen: true });
      if (!capture?.imageBuffer?.length) return null;
      return capture.imageBuffer.toString('base64');
    } finally {
      if (softCloakFn) softCloakFn(false);
      // A capture must not leave the visual control layer hidden. Restore the
      // secondary cursor immediately after the frame has been handed to the
      // planner, without contaminating the captured frame itself.
      if (desktopControl?.controlling) {
        await desktopControl.showAICursor?.(desktopControl.lastPoint, 'Planning next action…', 'thinking').catch(() => {});
      }
    }
  }

  async run(task, { softCloakFn } = {}) {
    const { desktopControl, windowManager } = this.deps;
    const runId = ++this.runId;
    if (this.running) this.stop();
    this.abort = false;
    this.running = true;
    this.abortController = new AbortController();

    await desktopControl.initialize();
    if (desktopControl.driver === 'none') {
      this.running = false;
      const message = 'Desktop control is unavailable. Enable Accessibility for OpenCluely, then try again.';
      this.#emit({ status: 'error', message, engine: this.engine });
      return { ok: false, error: 'desktop_control_unavailable', message };
    }
    await desktopControl.startControl(task);
    windowManager?.showAllWindows?.();
    windowManager?.centerMainWindowAtTop?.();

    // Start the native fast path before checking optional remote providers.
    // This makes simple launch/type requests immediate and never exposes an
    // irrelevant missing-Anthropic-key status before control actually begins.
    this.#emit({ status: 'running', message: `Take Control: ${task}`, engine: 'clyra-desktop-control' });

    try {
      const apiKey = (process.env.ANTHROPIC_API_KEY || process.env.CLYRA_ANTHROPIC_API_KEY || '').trim();
      const { computerAgentAvailability } = await import('./computer-agent-api.mjs');
      // The Clyra-hosted provider is optional. Give its loopback health check a
      // short budget, then use Clyra's Gemini screen-aware planner immediately.
      const backendComputerUse = !apiKey && await computerAgentAvailability({ timeoutMs: 450 });
      this.engine = apiKey || backendComputerUse ? 'anthropic-computer-use' : 'clyra-gemini-fallback';
      if (apiKey || backendComputerUse) {
        return await this.#runAnthropicAgent(task, {
          softCloakFn,
          apiKey,
          signal: this.abortController.signal,
        });
      }
      this.#emit({ status: 'step', message: 'Reading the screen with Clyra…', engine: this.engine });
      return await this.#runGeminiFallback(task, { softCloakFn });
    } finally {
      if (runId === this.runId) {
        this.running = false;
        this.abortController = null;
        await desktopControl.stopControl();
      }
    }
  }

  async #runExplicitDesktopShortcut(task) {
    const source = String(task || '').trim();
    const safeMove = /\b(?:move|place)\s+(?:the\s+)?(?:mouse\s+)?(?:cursor|mouse)\b[\s\S]*?\b(?:upper[-\s]?left|top[-\s]?left)\b/i.test(source);
    if (safeMove && !/\b(?:click|type|scroll|open|launch)\b/i.test(source)) {
      const { desktopControl } = this.deps;
      const bounds = screen.getPrimaryDisplay().workArea || screen.getPrimaryDisplay().bounds;
      const point = { x: bounds.x + 48, y: bounds.y + 96 };
      await desktopControl.move(point.x, point.y, 'Moving to a safe area');
      const message = 'Moved the cursor to a safe empty area.';
      this.#emit({ status: 'done', message, engine: this.engine });
      return { ok: true, done: true, shortcut: 'safe-cursor-move', point };
    }
    const appMatch = source.match(/\b(?:open|launch)\s+(google\s+chrome|chrome|safari)\b/i);
    const typeMatch = source.match(/\btype(?:\s+in)?\s+[“"']?(.+?)[”"']?(?=\s+(?:but\s+)?(?:do\s+not\s+)?(?:press|hit|click)\s+(?:enter|return)|\s+in\s+(?:the\s+)?(?:address|search)\s+bar|\s*$)/i);
    const text = String(typeMatch?.[1] || '').trim();
    // Opening a browser and asking to type is unambiguous: focus its address
    // bar even when the user did not explicitly say "address bar".
    if (!appMatch || !text || text.length > 240) return null;

    const { desktopControl } = this.deps;
    const wantsSafari = /safari/i.test(appMatch[1]);
    if (wantsSafari && process.platform === 'win32') {
      const message = 'Safari is not available on Windows. Ask to open Google Chrome, Microsoft Edge, or another installed browser instead.';
      this.#emit({ status: 'error', message, engine: this.engine });
      return { ok: false, error: 'app_unavailable_on_windows', message };
    }
    const appName = wantsSafari ? 'Safari' : 'Google Chrome';
    const displayBounds = screen.getPrimaryDisplay().workArea || screen.getPrimaryDisplay().bounds;
    // Keep the visual pointer independent from the person's real pointer. This
    // is deliberately close to the browser chrome so the action remains easy
    // to follow, while macOS receives the shortcut/click separately.
    const addressBarPoint = {
      x: displayBounds.x + Math.round(displayBounds.width * 0.3),
      y: displayBounds.y + 118,
    };
    await desktopControl.move?.(addressBarPoint.x, addressBarPoint.y, `Opening ${appName}`);
    this.#emit({ status: 'bash', message: `Opening ${appName}`, engine: this.engine });
    const launchCommand = process.platform === 'darwin'
      ? `open -a "${appName}"`
      : process.platform === 'win32'
        ? `start "" "${appName}"`
        : 'google-chrome || google-chrome-stable || chromium || chromium-browser';
    const launched = await this.bash.execute(launchCommand);
    if (launched.exitCode !== 0) {
      const message = launched.stderr || `${appName} could not be opened.`;
      this.#emit({ status: 'error', message, engine: this.engine });
      return { ok: false, error: 'chrome_open_failed', message };
    }
    await new Promise((resolve) => setTimeout(resolve, 850));
    await desktopControl.move?.(addressBarPoint.x, addressBarPoint.y, 'Focusing the address bar');
    const focused = await desktopControl.key(process.platform === 'darwin' ? 'cmd+l' : 'ctrl+l', 'Focus address bar');
    if (!focused?.ok) {
      const message = `${appName} opened, but macOS did not allow keyboard control: ${focused?.error || 'Accessibility permission is required.'}`;
      this.#emit({ status: 'error', message, engine: this.engine });
      return { ok: false, error: 'keyboard_control_unavailable', message };
    }
    await new Promise((resolve) => setTimeout(resolve, 120));
    const typed = await desktopControl.typeText(text, 'Type in address bar');
    if (!typed?.ok) {
      const message = `${appName} opened, but macOS did not allow typing: ${typed?.error || 'Accessibility permission is required.'}`;
      this.#emit({ status: 'error', message, engine: this.engine });
      return { ok: false, error: 'typing_unavailable', message };
    }
    const message = `Opened ${appName} and typed “${text}” in the address bar.`;
    this.#emit({ status: 'done', message, engine: this.engine });
    return { ok: true, done: true, shortcut: 'app-address-bar', appName, text };
  }

  async #runAnthropicAgent(task, { softCloakFn, apiKey, signal }) {
    const { desktopControl } = this.deps;
    const {
      sendComputerAgentMessage,
      textBlock,
      imageBlock,
      toolResultImage,
      toolResultText,
      anthropicModel,
    } = await import('./computer-agent-api.mjs');

    const display = screen.getPrimaryDisplay();
    const bounds = display.bounds || display.workArea;

    const initialScreenshot = await this.#captureJpegBase64(softCloakFn);
    if (!initialScreenshot) {
      const message = 'Could not capture the screen. Grant Screen Recording permission to OpenCluely, then try again.';
      this.#emit({ status: 'error', message, engine: this.engine });
      return { ok: false, error: 'capture_failed', message };
    }

    const messages = [
      {
        role: 'user',
        content: [
          textBlock(
            [
              `Complete this task on the user's desktop: ${task}`,
              `Display is ${bounds.width}x${bounds.height}. Coordinates in the computer tool use ${AI_WIDTH}x${AI_HEIGHT} AI space.`,
              safetyPromptRules(task),
            ].join('\n'),
          ),
          imageBlock(initialScreenshot),
        ],
      },
    ];

    for (let iteration = 1; iteration <= MAX_ITERATIONS; iteration += 1) {
      if (this.abort) {
        this.#emit({ status: 'stopped', message: 'Control stopped.', engine: this.engine });
        return { ok: true, stopped: true };
      }

      this.#emit({
        status: 'step',
        message: `Planning step ${iteration}…`,
        engine: this.engine,
        iteration,
      });

      let result;
      try {
        result = await sendComputerAgentMessage(messages, {
          apiKey,
          model: anthropicModel(),
          signal,
        });
      } catch (error) {
        if (this.abort || error?.name === 'AbortError') {
          this.#emit({ status: 'stopped', message: 'Control stopped.', engine: this.engine });
          return { ok: true, stopped: true };
        }
        this.#emit({ status: 'error', message: error.message, engine: this.engine });
        return { ok: false, error: error.message };
      }

      const content = result.content || [];
      messages.push({ role: 'assistant', content });

      const toolUses = content.filter((b) => b?.type === 'tool_use');
      const textParts = content
        .filter((b) => b?.type === 'text' && b.text)
        .map((b) => b.text)
        .join(' ')
        .trim();
      const thinkingParts = content
        .filter((b) => b?.type === 'thinking' && b.thinking)
        .map((b) => b.thinking)
        .join(' ')
        .trim();

      if (thinkingParts) {
        this.#emit({ status: 'thinking', message: thinkingParts.slice(0, 280), engine: this.engine });
      }
      if (textParts) {
        this.#emit({ status: 'response', message: textParts.slice(0, 400), engine: this.engine });
      }

      if (!toolUses.length) {
        this.#emit({
          status: 'done',
          message: textParts || 'Task complete.',
          engine: this.engine,
        });
        return { ok: true, done: true, message: textParts };
      }

      const toolResults = [];

      for (const tool of toolUses) {
        if (this.abort) break;
        const name = tool.name;
        const input = tool.input || {};

        if (name === 'computer') {
          const actionName = String(input.action || '');
          this.#emit({
            status: 'action',
            message: actionName || 'computer',
            action: input,
            engine: this.engine,
          });

          try {
            if (softCloakFn) softCloakFn(true);
            await new Promise((r) => setTimeout(r, 80));
            const actionResult = await desktopControl.performComputerAction(input, task);
            if (actionResult?.blocked) {
              toolResults.push(toolResultText(tool.id, `Blocked: ${actionResult.reason}`));
              this.#emit({ status: 'blocked', message: actionResult.reason, engine: this.engine });
              continue;
            }
          } catch (error) {
            toolResults.push(toolResultText(tool.id, `Error: ${error.message}`));
            continue;
          } finally {
            if (softCloakFn) softCloakFn(false);
          }

          if (actionName === 'screenshot' || actionName === 'zoom') {
            const shot = await this.#captureJpegBase64(softCloakFn);
            if (shot) toolResults.push(toolResultImage(tool.id, shot));
            else toolResults.push(toolResultText(tool.id, 'Screenshot capture failed'));
          } else {
            await new Promise((r) => setTimeout(r, 350));
            const shot = await this.#captureJpegBase64(softCloakFn);
            if (shot) toolResults.push(toolResultImage(tool.id, shot));
            else toolResults.push(toolResultText(tool.id, 'Screenshot capture failed'));
          }
        } else if (name === 'bash') {
          const command = input.command;
          const restart = Boolean(input.restart);
          if (restart) {
            this.bash.restart();
            toolResults.push(toolResultText(tool.id, 'Bash session restarted'));
            continue;
          }
          if (command) {
            this.#emit({ status: 'bash', message: String(command).slice(0, 120), engine: this.engine });
            try {
              const out = await this.bash.execute(command);
              const text = [out.stdout, out.stderr].filter(Boolean).join('\n').trim() || `(exit ${out.exitCode})`;
              toolResults.push(toolResultText(tool.id, text.slice(0, 8000)));
            } catch (error) {
              toolResults.push(toolResultText(tool.id, `Error: ${error.message}`));
            }
          }
        } else {
          toolResults.push(
            toolResultText(tool.id, `Tool ${name} is handled server-side or not supported in OpenCluely yet.`),
          );
        }
      }

      if (toolResults.length) {
        messages.push({ role: 'user', content: toolResults });
      }
    }

    this.#emit({ status: 'done', message: 'Reached step limit.', engine: this.engine });
    return { ok: true, done: true, limit: true };
  }

  async #runGeminiFallback(task, { softCloakFn }) {
    const orchestrator = new OsAiComputerUseOrchestrator(this.deps);
    return orchestrator.run({
      task,
      softCloakFn,
      onEvent: (event, payload) => {
        if (this.abort) orchestrator.cancel();
        this.#emit(payload);
      },
    });
  }
}

module.exports = { ComputerAgentService, AI_WIDTH, AI_HEIGHT };
