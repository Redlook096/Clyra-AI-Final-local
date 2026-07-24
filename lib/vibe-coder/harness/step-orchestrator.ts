import { useState, useCallback, useRef } from "react";
import { AgentRenderQueue, AgentPhase, RenderBlock } from "./agent-render-queue";
import { VibePlan } from "../../../types/vibe-plan";
import { VibePreviewState } from "../../../types/vibe-preview";

const delay = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function generateThinkingText(phase: string, plan?: VibePlan): string {
  switch (phase) {
    case "understanding":
      return "Analyzing your request and identifying the scope of work...";
    case "task_group_preparing":
      if (!plan) return "Preparing execution batches from PLAN.md...";
      const taskCount = plan.taskGraph?.length || 0;
      const fileCount = plan.proposedFileTree?.length || 0;
      return `Grouping ${taskCount} tasks into execution batches. ${fileCount} files to create/edit across the project.`;
    case "checkpointing":
      return "Creating checkpoint and preparing workspace...";
    case "file_editing":
      if (!plan) return "Executing file changes from PLAN.md...";
      return "Applying file changes in grouped batches...";
    case "validating":
      return "Running validation checks against PLAN.md requirements...";
    case "previewing":
      return "Opening live preview to verify implementation...";
    case "reviewing":
      return "Performing final review against plan specifications...";
    default:
      return "Processing...";
  }
}

export function useStepOrchestrator(options?: { planReviewEnabled?: boolean }) {
  // Plan review is opt-in. When the workspace has no approval surface (the
  // current default), gating on `awaiting_approval` would pause the run on a
  // card nobody can click — so the plan renders and the run continues.
  const planReviewEnabled = options?.planReviewEnabled ?? false;
  const [activeBlocks, setActiveBlocks] = useState<RenderBlock[]>([]);
  const queueRef = useRef(new AgentRenderQueue((active) => {
    setActiveBlocks([...active]);
  }));
  const queue = queueRef.current;

  const [currentPhase, setCurrentPhase] = useState<AgentPhase>("idle");
  const planRef = useRef<VibePlan | null>(null);

  const startFlow = useCallback(async () => {
    setCurrentPhase("understanding");

    queue.enqueue({
      id: `thinking-${Date.now()}`,
      type: "thinking",
      phase: "understanding",
      renderPolicy: "replace_current",
      payload: { text: generateThinkingText("understanding") }
    });

    await delay(800);
  }, [queue]);

  const onPlanApproved = useCallback(async (plan: VibePlan) => {
    planRef.current = plan;
    const planBlock = queue.getActiveBlocks().find(b => b.type === "plan_card");
    if (planBlock) queue.finishBlock(planBlock.id);

    setCurrentPhase("checkpointing");
    queue.enqueue({
      id: `checkpoint-${Date.now()}`,
      type: "checkpoint_status",
      phase: "checkpointing",
      renderPolicy: "sequential",
      payload: { text: "Plan Approved" }
    });

    await delay(600);
    const checkBlock = queue.getActiveBlocks().find(b => b.type === "checkpoint_status");
    if (checkBlock) queue.finishBlock(checkBlock.id);

    setCurrentPhase("task_group_preparing");
    const taskThinkingText = generateThinkingText("task_group_preparing", plan);
    queue.enqueue({
      id: `thinking-tasks-${Date.now()}`,
      type: "thinking",
      phase: "task_group_preparing",
      renderPolicy: "replace_current",
      payload: { text: taskThinkingText }
    });

    await delay(1200);
    const thinkingBlock = queue.getActiveBlocks().find(b => b.type === "thinking");
    if (thinkingBlock) queue.finishBlock(thinkingBlock.id);
  }, [queue]);

  const onPlanReady = useCallback(async (plan: VibePlan) => {
    planRef.current = plan;

    if (!planReviewEnabled) {
      // No approval surface exists: show the plan as an informational card
      // and proceed straight to execution instead of pausing the run.
      queue.enqueue({
        id: `plan-card-${Date.now()}`,
        type: "plan_card",
        phase: "task_group_preparing",
        renderPolicy: "sequential",
        payload: { plan }
      });
      await onPlanApproved(plan);
      return;
    }

    setCurrentPhase("awaiting_approval");
    queue.enqueue({
      id: `plan-card-${Date.now()}`,
      type: "plan_card",
      phase: "awaiting_approval",
      renderPolicy: "requires_user_action",
      payload: { plan }
    });
  }, [onPlanApproved, planReviewEnabled, queue]);

  const onFilesReady = useCallback(async (patches: any[], plan: VibePlan) => {
    planRef.current = plan;
    setCurrentPhase("file_editing");

    queue.enqueue({
      id: `boxes-${Date.now()}`,
      type: "mini_code_box_group",
      phase: "file_editing",
      renderPolicy: "sequential",
      payload: { patches, plan }
    });
  }, [queue]);

  const onPreviewReady = useCallback(async () => {
    const prevBlock = queue.getActiveBlocks().find(b => b.type === "preview_card");
    if (prevBlock) queue.unblock(prevBlock.id);

    setCurrentPhase("reviewing");
    queue.enqueue({
      id: `review-${Date.now()}`,
      type: "review_card",
      phase: "reviewing",
      renderPolicy: "sequential"
    });

    await delay(1200);
    const revBlock = queue.getActiveBlocks().find(b => b.type === "review_card");
    if (revBlock) queue.unblock(revBlock.id);

    setCurrentPhase("complete");
    queue.enqueue({
      id: `complete-${Date.now()}`,
      type: "build_complete",
      phase: "complete",
      renderPolicy: "sequential"
    });
  }, [queue]);

  const onFilesComplete = useCallback(async () => {
    const boxBlock = queue.getActiveBlocks().find(b => b.type === "mini_code_box_group");
    if (boxBlock) queue.unblock(boxBlock.id);

    setCurrentPhase("validating");
    queue.enqueue({
      id: `validation-${Date.now()}`,
      type: "validation_card",
      phase: "validating",
      renderPolicy: "sequential"
    });

    await delay(1800);

    const valBlock = queue.getActiveBlocks().find(b => b.type === "validation_card");
    if (valBlock) queue.unblock(valBlock.id);

    setCurrentPhase("previewing");
    queue.enqueue({
      id: `preview-${Date.now()}`,
      type: "preview_card",
      phase: "previewing",
      renderPolicy: "sequential"
    });

    await delay(1200);

    setCurrentPhase("browser_testing");
    queue.enqueue({
      id: `browser-${Date.now()}`,
      type: "browser_action_summary",
      phase: "browser_testing",
      renderPolicy: "sequential"
    });

    setTimeout(() => {
      onPreviewReady();
    }, 1500);
  }, [queue, onPreviewReady]);

  const clearQueue = useCallback(() => {
    queue.clear();
    setCurrentPhase("idle");
    planRef.current = null;
  }, [queue]);

  return {
    queue,
    activeBlocks,
    currentPhase,
    startFlow,
    onPlanReady,
    onPlanApproved,
    onFilesReady,
    onFilesComplete,
    onPreviewReady,
    clearQueue
  };
}
