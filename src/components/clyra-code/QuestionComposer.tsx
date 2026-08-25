import { useEffect, useMemo, useRef, useState } from "react";
import { motion } from "motion/react";
import { ArrowLeft, ArrowRight, Check } from "lucide-react";
import { cn } from "../../lib/utils";

export type QuestionOption = string;

export type Question = {
  id: string;
  question: string;
  type: "single" | "multi";
  options: string[];
  allowCustom?: boolean;
  customPlaceholder?: string;
  required?: boolean;
};

export type QuestionAnswers = Record<string, { values: string[]; custom: string }>;

export type QuestionSet = {
  questions: Question[];
};

const EASE = [0.22, 1, 0.36, 1] as const;

/** Compact question → answer rows for the transcript's user message. */
export function summarizeAnswers(
  questionSet: QuestionSet | null,
  answers: QuestionAnswers,
): Array<{ question: string; answer: string }> {
  if (!questionSet) return [];
  const rows: Array<{ question: string; answer: string }> = [];
  for (const q of questionSet.questions) {
    const a = answers[q.id];
    const value = (a?.custom ?? "").trim() || (a?.values ?? []).join(", ");
    if (value) rows.push({ question: q.question, answer: value });
  }
  const ctx = (answers.context?.custom ?? "").trim();
  if (ctx) rows.push({ question: "Context", answer: ctx });
  return rows;
}

export function QuestionComposer({
  questionSet,
  continueLabel = "Continue",
  submitting = false,
  onBack,
  onSubmit,
}: {
  questionSet: QuestionSet;
  continueLabel?: string;
  submitting?: boolean;
  onBack?: () => void;
  onSubmit: (answers: QuestionAnswers) => void;
}) {
  const [selected, setSelected] = useState<Record<string, string[]>>({});
  const [custom, setCustom] = useState<Record<string, string>>({});
  const [customOpen, setCustomOpen] = useState<Record<string, boolean>>({});
  const [context, setContext] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    setSelected({});
    setCustom({});
    setCustomOpen({});
    setContext("");
  }, [questionSet]);

  const questions = questionSet.questions ?? [];
  const required = useMemo(
    () => new Set(questions.filter((q) => q.required !== false).map((q) => q.id)),
    [questions],
  );

  const isAnswered = (q: Question) => {
    const values = selected[q.id] ?? [];
    const text = (custom[q.id] ?? "").trim();
    if (!required.has(q.id)) return true;
    if (text) return true;
    return values.length > 0;
  };

  const complete = questions.every(isAnswered);

  const toggle = (q: Question, option: string) => {
    setSelected((prev) => {
      const current = prev[q.id] ?? [];
      if (q.type === "multi") {
        return {
          ...prev,
          [q.id]: current.includes(option)
            ? current.filter((value) => value !== option)
            : [...current, option],
        };
      }
      return { ...prev, [q.id]: [option] };
    });
    if (q.type === "single") setCustomOpen((prev) => ({ ...prev, [q.id]: false }));
  };

  const buildAnswers = (): QuestionAnswers => {
    const answers: QuestionAnswers = {};
    for (const q of questions) {
      answers[q.id] = { values: selected[q.id] ?? [], custom: custom[q.id] ?? "" };
    }
    if (context.trim()) answers.context = { values: [], custom: context.trim() };
    return answers;
  };

  const submit = () => {
    if (!complete || submitting) return;
    onSubmit(buildAnswers());
  };

  return (
    <div
      ref={rootRef}
      data-testid="question-composer"
      onKeyDown={(event) => {
        if (event.key === "Enter" && !(event.target instanceof HTMLTextAreaElement) && !(event.target instanceof HTMLInputElement)) {
          event.preventDefault();
          submit();
        }
        if (event.key === "Escape" && onBack) {
          event.preventDefault();
          onBack();
        }
      }}
      className="flex flex-col px-3 pb-2 pt-2.5"
    >
      <div className="cc-scroll flex max-h-[42vh] flex-col gap-2.5 overflow-y-auto pr-0.5">
        {questions.map((q, index) => {
          const values = selected[q.id] ?? [];
          const customText = custom[q.id] ?? "";
          const open = customOpen[q.id] ?? false;
          return (
            <motion.div
              key={q.id}
              initial={{ opacity: 0, y: 6 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ duration: 0.24, ease: EASE, delay: 0.025 * index }}
            >
              <p className="mb-1 text-[13px] font-medium leading-[1.3] text-[#202124]">{q.question}</p>
              <div className="flex flex-col gap-[1px]">
                {q.options.map((option) => {
                  const active = values.includes(option);
                  return (
                    <button
                      key={option}
                      type="button"
                      data-q-option
                      data-q-id={q.id}
                      aria-pressed={active}
                      onClick={() => toggle(q, option)}
                      className={cn(
                        "group flex h-[26px] items-center gap-2 rounded-[6px] px-1.5 text-left text-[12.5px] outline-none transition-colors duration-100 focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:bg-black/[0.03]",
                        active ? "bg-[#3977F6]/[0.07] text-[#2E68E5]" : "text-[#4B4D52] hover:bg-black/[0.03]",
                      )}
                    >
                      <span
                        className={cn(
                          "flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full border transition-colors duration-100",
                          active ? "border-[#3977F6] bg-[#3977F6]" : "border-[#C6C8CC] group-hover:border-[#A6A8AD]",
                        )}
                        aria-hidden
                      >
                        {active ? <Check className="h-[9px] w-[9px] text-white" strokeWidth={3} /> : null}
                      </span>
                      <span className={cn("min-w-0 flex-1", active && "font-medium")}>{option}</span>
                    </button>
                  );
                })}
                {q.allowCustom ? (
                  open ? (
                    <motion.input
                      autoFocus
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      value={customText}
                      onChange={(event) => setCustom((prev) => ({ ...prev, [q.id]: event.target.value }))}
                      placeholder={q.customPlaceholder ?? "Other…"}
                      className="ml-[19px] mt-0.5 w-[calc(100%-19px)] rounded-[6px] border border-[#3977F6]/40 bg-white px-2 py-1 text-[12.5px] text-[#202124] outline-none placeholder:text-[#B0B2B6]"
                    />
                  ) : (
                    <button
                      type="button"
                      data-q-option
                      onClick={() => {
                        setCustomOpen((prev) => ({ ...prev, [q.id]: true }));
                        if (q.type === "single") setSelected((prev) => ({ ...prev, [q.id]: [] }));
                      }}
                      className="flex h-[26px] items-center gap-2 rounded-[6px] px-1.5 text-left text-[12.5px] text-[#7A7D82] outline-none transition-colors duration-100 hover:bg-black/[0.03] focus:outline-none focus-visible:outline-none focus-visible:ring-0 focus-visible:bg-black/[0.03]"
                    >
                      <span className="flex h-[13px] w-[13px] shrink-0 items-center justify-center rounded-full border border-dashed border-[#C6C8CC]" aria-hidden />
                      <span>Other…</span>
                    </button>
                  )
                ) : null}
              </div>
            </motion.div>
          );
        })}
      </div>

      <div className="mt-2 flex items-center gap-2">
        <input
          value={context}
          onChange={(event) => setContext(event.target.value)}
          placeholder="Add context…"
          className="min-w-0 flex-1 rounded-[6px] bg-transparent px-1.5 py-1 text-[12.5px] text-[#202124] outline-none placeholder:text-[#B0B2B6]"
        />
        {onBack ? (
          <button
            type="button"
            onClick={onBack}
            data-testid="question-back"
            className="flex h-7 shrink-0 items-center gap-1 rounded-[7px] px-2 text-[12px] font-medium text-[#6B6E73] transition-colors hover:bg-black/[0.04] hover:text-[#303236]"
          >
            <ArrowLeft className="h-3.5 w-3.5" strokeWidth={2} />
            Back
          </button>
        ) : null}
        <button
          type="button"
          onClick={submit}
          data-testid="question-continue"
          disabled={!complete || submitting}
          className={cn(
            "flex h-7 shrink-0 items-center gap-1 rounded-[7px] px-3 text-[12px] font-medium transition-all duration-150 active:scale-[0.97]",
            complete && !submitting
              ? "bg-[#3977F6] text-white hover:bg-[#2E68E5]"
              : "bg-[#F0F0EF] text-[#B7B8BA]",
          )}
        >
          {submitting ? "Working…" : continueLabel}
          <ArrowRight className="h-3.5 w-3.5" strokeWidth={2} />
        </button>
      </div>
    </div>
  );
}
