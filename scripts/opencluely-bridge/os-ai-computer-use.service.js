/**
 * OpenCluely Take Control — powered by 777genius/os-ai-computer-use architecture.
 * Reference: https://github.com/777genius/os-ai-computer-use
 */
const { screen } = require('electron');

const AI_WIDTH = 1280;
const AI_HEIGHT = 800;
const MAX_ITERATIONS = 30;

class OsAiComputerUseOrchestrator {
  constructor(deps) {
    this.deps = deps;
    this.cancelled = false;
  }

  cancel() {
    this.cancelled = true;
  }

  async run({ task, softCloakFn, onEvent }) {
    const { llmService, desktopControl, captureService } = this.deps;
    const bounds = screen.getPrimaryDisplay().bounds;
    let lastSummary = '';

    onEvent?.('status', { status: 'running', message: `Take Control (os-ai-computer-use): ${task}`, engine: 'os-ai-computer-use' });

    // Pre-activate target application if explicitly named in the task (e.g. Chrome)
    if (/\b(?:chrome|google chrome)\b/i.test(task)) {
      try {
        if (process.platform === 'darwin') {
          const { execFile } = require('child_process');
          const { promisify } = require('util');
          await promisify(execFile)('open', ['-a', 'Google Chrome']).catch(() => {});
        }
        await new Promise((r) => setTimeout(r, 600));
      } catch (_) { /* ignore */ }
    }

    const actionHistory = [];

    for (let step = 0; step < MAX_ITERATIONS; step += 1) {
      if (this.cancelled) {
        onEvent?.('status', { status: 'stopped', message: 'Control stopped.', engine: 'os-ai-computer-use' });
        return { ok: true, stopped: true };
      }

      let capture;
      try {
        desktopControl?.cloakOverlaysForCapture?.();
        if (softCloakFn) softCloakFn(true);
        await new Promise((r) => setTimeout(r, 80));
        capture = await captureService.captureForComputerAgent({ fullScreen: true });
      } finally {
        if (softCloakFn) softCloakFn(false);
        desktopControl?.uncloakOverlaysAfterCapture?.();
      }

      if (!capture?.imageBuffer?.length) {
        onEvent?.('status', {
          status: 'error',
          message: 'Could not capture the screen. Grant Screen Recording + Accessibility permissions.',
          engine: 'os-ai-computer-use',
        });
        return { ok: false, error: 'capture_failed' };
      }

      onEvent?.('status', { status: 'thinking', message: `Analyzing screen (step ${step + 1})…`, engine: 'os-ai-computer-use' });

      const visionPrompt = [
        `You are os-ai-computer-use controlling the OS desktop. Task: "${task}".`,
        `AI coordinate space is ${AI_WIDTH}x${AI_HEIGHT}. Display is ${bounds.width}x${bounds.height}.`,
        lastSummary ? `Previous step: ${lastSummary}` : '',
        'Execute ONLY the steps required for the specific task.',
        'CRITICAL RULE: Once the user request has been fulfilled on screen, return {"done":true,"note":"Task finished."} IMMEDIATELY. Do NOT perform any random, unrequested, or extra actions after completion.',
        'Reply ONLY JSON:',
        '{"done":false,"action":{"action":"left_click"|"mouse_move"|"type"|"key"|"scroll"|"left_click_drag"|"right_click"|"double_click"|"wait","coordinate":[x,y],"start_coordinate":[x,y],"text":"","scroll_direction":"down","scroll_amount":3},"note":"..."}',
        '{"done":true,"note":"Task verified complete."}',
      ].join('\n');

      const vision = await llmService.callVision(
        capture.imageBuffer,
        visionPrompt,
        capture.mimeType || 'image/jpeg',
      );

      const match = String(vision || '').match(/\{[\s\S]*\}/);
      let plan = null;
      if (match) {
        try { plan = JSON.parse(match[0]); } catch { plan = null; }
      }

      if (!plan) {
        lastSummary = 'Planner returned invalid JSON; retrying step';
        onEvent?.('status', { status: 'step', message: lastSummary, engine: 'os-ai-computer-use' });
        continue;
      }

      if (plan.done) {
        const msg = String(plan.note || 'Task complete.');
        onEvent?.('status', { status: 'done', message: msg, engine: 'os-ai-computer-use' });
        return { ok: true, done: true, message: msg };
      }

      const input = plan.action || {};
      if (input.action) {
        const sig = `${input.action}:${JSON.stringify(input.coordinate || [])}:${input.text || ''}`;
        actionHistory.push(sig);
        const recent3 = actionHistory.slice(-3);
        if (recent3.length === 3 && recent3[0] === sig && recent3[1] === sig && recent3[2] === sig) {
          const doneMsg = `Task completed (stopping duplicate action: ${input.action}).`;
          onEvent?.('status', { status: 'done', message: doneMsg, engine: 'os-ai-computer-use' });
          return { ok: true, done: true, message: doneMsg };
        }

        const actionLabel = `${input.action}${input.text ? `: "${input.text}"` : ''}`;
        onEvent?.('status', { status: 'action', message: actionLabel, action: input, engine: 'os-ai-computer-use' });

        try {
          if (softCloakFn) softCloakFn(true);
          await new Promise((r) => setTimeout(r, 60));
          const result = await desktopControl.performComputerAction(input, task);
          if (result?.blocked) {
            onEvent?.('status', { status: 'done', message: result.reason, engine: 'os-ai-computer-use', blocked: true });
            return { ok: true, blocked: true, reason: result.reason };
          }
          lastSummary = String(plan.note || actionLabel);
          onEvent?.('status', { status: 'step', message: lastSummary, engine: 'os-ai-computer-use', action: input });
        } finally {
          if (softCloakFn) softCloakFn(false);
        }
      }

      await new Promise((r) => setTimeout(r, 350));
    }

    const finalMsg = lastSummary || 'Reached iteration limit.';
    onEvent?.('status', { status: 'done', message: finalMsg, engine: 'os-ai-computer-use' });
    return { ok: true, done: true, limit: true };
  }
}

module.exports = { OsAiComputerUseOrchestrator, AI_WIDTH, AI_HEIGHT, MAX_ITERATIONS };
