export type AgentStage =
  | "idle"
  | "task-created"
  | "inspecting-existing-project"
  | "auditing-old-system"
  | "researching-web"
  | "planning"
  | "writing-plan-md"
  | "extracting-file-queue"
  | "creating-checkpoint"
  | "generating-file"
  | "editing-file"
  | "reviewing-file"
  | "running-install"
  | "running-build"
  | "running-lint"
  | "running-tests"
  | "fixing-errors"
  | "starting-preview"
  | "validating-preview"
  | "final-review"
  | "complete"
  | "failed"
  | "cancelled"
  | "paused"
  | "running-command";

export type VibeCoderEvent =
  | {
      type: "stage";
      stage: AgentStage;
      message: string;
      timestamp?: number;
    }
  | {
      type: "thinking";
      text: string;
      timestamp?: number;
    }
  | {
      type: "mode_changed";
      mode: "plan" | "code";
      label: string;
      message: string;
      timestamp?: number;
    }
  | {
      type: "plan_started";
      timestamp?: number;
    }
  | {
      type: "plan_delta";
      delta: string;
      timestamp?: number;
    }
  | {
      type: "plan_completed";
      path: "PLAN.md";
      content: string;
      timestamp?: number;
    }
  | {
      type: "file_queue_created";
      files: Array<{
        path: string;
        action: "create" | "edit" | "delete";
        reason: string;
      }>;
      timestamp?: number;
    }
  | {
      type: "status_update";
      message: string;
      timestamp?: number;
    }
  | {
      type: "file_started";
      path: string;
      language: string;
      action: "create" | "edit" | "delete";
      stepId?: string;
      timestamp?: number;
    }
  | {
      type: "file_delta";
      path: string;
      delta: string;
      timestamp?: number;
    }
  | {
      type: "file_completed";
      path: string;
      content: string;
      timestamp?: number;
    }
  | {
      type: "terminal_started";
      command: string;
      timestamp?: number;
    }
  | {
      type: "terminal_output";
      command: string;
      output: string;
      timestamp?: number;
    }
  | {
      type: "terminal_completed";
      command: string;
      exitCode: number;
      timestamp?: number;
    }
  | {
      type: "preview_starting";
      timestamp?: number;
    }
  | {
      type: "preview_ready";
      url: string;
      timestamp?: number;
    }
  | {
      type: "checkpoint_created";
      id: string;
      label: string;
      timestamp?: number;
    }
  | {
      type: "error";
      message: string;
      recoverable: boolean;
      timestamp?: number;
    }
  | {
      type: "complete";
      summary: string;
      timestamp?: number;
    };
