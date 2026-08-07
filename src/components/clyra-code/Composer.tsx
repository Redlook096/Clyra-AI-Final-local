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
    <div className="px-4 pb-2.5 pt-1">
      <div className="mx-auto max-w-[620px] rounded-[11px] border border-[#EEEEEC] bg-white transition-[border-color] duration-150 focus-within:border-[#D8D8D6]">
        {contexts.length > 0 ? (
          <div className="flex flex-wrap gap-1 px-2.5 pt-2">
            {contexts.map((context) => (
              <span
                key={context.id}
                className="flex items-center gap-1 rounded-[6px] bg-[#F6F6F5] px-1.5 py-px text-[10.5px] text-[#5F6368]"
                title={context.detail}
              >
                {context.label}
                <button
                  type="button"
                  aria-label="Remove context"
                  onClick={() => onRemoveContext(context.id)}
                  className="text-[#8A8A8A] hover:text-[#171717]"
                >
                  <X className="h-2.5 w-2.5" />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        <textarea
          ref={textareaRef}
          value={value}
          rows={1}
          placeholder={placeholder}
          onChange={(event) => {
            setValue(event.target.value);
            const node = event.target;
            node.style.height = "auto";
            node.style.height = `${Math.min(140, node.scrollHeight)}px`;
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.shiftKey) {
              event.preventDefault();
              submit();
            }
          }}
          className="w-full resize-none bg-transparent px-3 pt-2.5 text-[12.5px] leading-[1.45] tracking-[-0.01em] text-[#171717] outline-none placeholder:text-[#8A8A8A]"
        />
        <div className="flex h-8 items-center gap-1.5 px-2 pb-1.5">
          <button
            type="button"
            aria-label="Add attachment"
            className="rounded-[6px] p-1 text-[#8A8A8A] transition-colors hover:bg-[#F6F6F5]"
          >
            <Paperclip className="h-3.5 w-3.5" strokeWidth={1.7} />
          </button>
          {model ? (
            <span className="cc-mono text-[10.5px] text-[#8A8A8A]">{model}</span>
          ) : null}
          <span className="flex-1" />
          {running ? (
            <button
              type="button"
              onClick={onStop}
              aria-label="Stop"
              className="flex h-6 w-6 items-center justify-center rounded-full bg-[#171717] text-white transition-transform active:scale-[0.96]"
            >
              <Square className="h-[9px] w-[9px]" fill="currentColor" />
            </button>
          ) : (
            <button
              type="button"
              onClick={submit}
              disabled={!value.trim()}
              aria-label="Send"
              className={cn(
                "flex h-6 w-6 items-center justify-center rounded-full transition-all active:scale-[0.96]",
                value.trim()
                  ? "bg-[#2563eb] text-white"
                  : "bg-[#F0F0EE] text-[#B0B0B0]",
              )}
            >
              <ArrowUp className="h-3.5 w-3.5" strokeWidth={2.2} />
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
