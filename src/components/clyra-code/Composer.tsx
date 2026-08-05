import { useCallback, useRef, useState } from "react";
import { ArrowUp, Paperclip, Square, X } from "lucide-react";
import { cn } from "../../lib/utils";

export type ComposerContext = {
  id: string;
  label: string;
  detail: string;
};

export function Composer({
  running,
  model,
  contexts,
  onRemoveContext,
  onSubmit,
  onStop,
  placeholder = "Ask for follow-up changes",
}: {
  running: boolean;
  model: string | null;
  contexts: ComposerContext[];
  onRemoveContext: (id: string) => void;
  onSubmit: (text: string) => void;
  onStop: () => void;
  placeholder?: string;
}) {
  const [value, setValue] = useState("");
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);

  const submit = useCallback(() => {
    const text = value.trim();
    if (!text) return;
    const contextBlock = contexts.length
      ? `${contexts.map((c) => `[${c.label}] ${c.detail}`).join("\n")}\n\n`
      : "";
    onSubmit(contextBlock + text);
    setValue("");
    contexts.forEach((c) => onRemoveContext(c.id));
    if (textareaRef.current) textareaRef.current.style.height = "auto";
  }, [value, contexts, onSubmit, onRemoveContext]);

  return (
    <div className="px-4 pb-2 pt-1">
      <div className="mx-auto max-w-[720px] rounded-[12px] border border-[color:var(--border-medium)] bg-white shadow-[0_2px_10px_rgba(15,23,42,0.04)]">
        {contexts.length > 0 ? (
          <div className="flex flex-wrap gap-1.5 px-3 pt-2.5">
            {contexts.map((context) => (
              <span
                key={context.id}
                className="flex items-center gap-1 rounded-[6px] bg-[color:var(--surface-muted)] px-2 py-[3px] text-[11px] text-[color:var(--text-secondary)]"
                title={context.detail}
              >
                {context.label}
                <button
                  type="button"
                  aria-label="Remove context"
                  onClick={() => onRemoveContext(context.id)}
                  className="text-[color:var(--text-tertiary)] hover:text-[color:var(--text-primary)]"
                >
                  <X className="h-3 w-3" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          rows={2}
          placeholder={placeholder}
          onChange={(event) => {
            setValue(event.target.value);
            const node = event.target;
            node.style.height = "auto";
            node.style.height = `${Math.min(180, node.scrollHeight)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="w-full resize-none bg-transparent px-3.5 pt-3 text-[13px] leading-[1.5] text-[color:var(--text-primary)] outline-none placeholder:text-[color:var(--text-tertiary)]"
        />
        <div className="flex items-center gap-2 px-2.5 pb-2.5 pt-1">
          <button
            type="button"
            aria-label="Add attachment"
            className="rounded-[7px] p-1.5 text-[color:var(--text-tertiary)] transition-colors hover:bg-[color:var(--surface-hover)]"
          >
            <Paperclip className="h-[15px] w-[15px]" strokeWidth={1.7} />
          </button>
          {model ? (
            <span className="cc-mono text-[11px] text-[color:var(--text-tertiary)]">{model}</span>
          ) : null}
          <span className="flex-1" />
          {running ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              className="flex h-[28px] w-[28px] items-center justify-center rounded-full bg-[color:var(--text-primary)] text-white transition-transform active:scale-[0.96]"
            >
              <Square className="h-[11px] w-[11px]" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim()}
              aria-label="Send"
              className={cn(
                "flex h-[28px] w-[28px] items-center justify-center rounded-full transition-all active:scale-[0.96]",
                value.trim()
                  ? "bg-[color:var(--accent-blue)] text-white"
                  : "bg-[color:var(--surface-muted)] text-[color:var(--text-disabled)]",
              )}
            >
              <ArrowUp className="h-[14px] w-[14px]" strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
