import type { ComponentPropsWithoutRef } from "react";
import Markdown, { type Components } from "react-markdown";
import { Prism as SyntaxHighlighter } from "react-syntax-highlighter";
import oneLight from "react-syntax-highlighter/dist/esm/styles/prism/one-light.js";
import { vscDarkPlus } from "react-syntax-highlighter/dist/esm/styles/prism";
import remarkGfm from "remark-gfm";
import { cn } from "../lib/utils";

type CodeProps = ComponentPropsWithoutRef<"code"> & {
  inline?: boolean;
  className?: string;
  children?: React.ReactNode;
};

export function MarkdownMessageContent({
  content,
  codeHighlighting = true,
  codePresentation = "default",
  /** When true, fenced blocks are omitted and inline code is plain text (e.g. Vibe mode — no code UI). */
  suppressCodeBlocks = false,
}: {
  content: string;
  codeHighlighting?: boolean;
  /** `soft` = light surface for Vibe coder (no dark code slab). */
  codePresentation?: "default" | "soft";
  suppressCodeBlocks?: boolean;
}) {
  const soft = codePresentation === "soft";

  const components: Partial<Components> = {
    a({ href, children, node: _node, ref: _ref, ...props }) {
      const isClipperVideo =
        typeof href === "string" && false && href.endsWith(".mp4");
      if (isClipperVideo) {
        return (
          <span className="my-3 block overflow-hidden rounded-2xl border border-slate-200/80 bg-white shadow-[0_18px_50px_rgba(15,23,42,0.08)]">
            <video
              src={href}
              controls
              preload="metadata"
              className="block aspect-video w-full bg-slate-950"
            />
            <span className="flex items-center justify-between gap-3 px-3 py-2 text-[12px] font-semibold text-slate-600">
              <span>Generated MP4</span>
              <a
                {...props}
                href={href}
                download
                className="rounded-full bg-slate-950 px-3 py-1.5 text-white transition-colors hover:bg-slate-800"
              >
                {children}
              </a>
            </span>
          </span>
        );
      }
      const googleWorkspaceMatch = typeof href === "string"
        ? href.match(/^https:\/\/(docs\.google\.com\/(document|spreadsheets)\/|calendar\.google\.com\/|mail\.google\.com\/)/)
        : null;
      const googleWorkspaceLabel = googleWorkspaceMatch?.[2] === "spreadsheets"
        ? "Open Google Sheet"
        : googleWorkspaceMatch?.[2] === "document"
          ? "Open Google Doc"
          : href?.startsWith("https://calendar.google.com")
            ? "Open Google Calendar"
            : href?.startsWith("https://mail.google.com")
              ? "Open Gmail"
              : null;
      return (
        <a
          {...props}
          href={href}
          target={href?.startsWith("http") ? "_blank" : undefined}
          rel={href?.startsWith("http") ? "noopener noreferrer" : undefined}
          className={cn(
            googleWorkspaceLabel
              ? "clyra-workspace-open-link"
              : "font-semibold text-slate-900 underline decoration-slate-300 underline-offset-4 transition-colors hover:text-slate-600",
          )}
        >
          {googleWorkspaceLabel || children}
        </a>
      );
    },
    code({ inline, className, children, ...props }: CodeProps) {
      const match = /language-(\w+)/.exec(className || "");
      const text = String(children).replace(/\n$/, "");
      const isInlineCode = inline ?? !className;

      if (suppressCodeBlocks) {
        if (!isInlineCode && text.includes("\n")) return null;
        return (
          <span className="font-mono text-[0.94em] text-inherit" {...props}>
            {children}
          </span>
        );
      }

      if (!inline && match && codeHighlighting) {
        return (
          <SyntaxHighlighter
            {...props}
            style={soft ? oneLight : vscDarkPlus}
            language={match[1]}
            PreTag="div"
            className={cn(
              soft
                ? "my-3 rounded-xl border border-slate-200/90 shadow-[0_1px_3px_rgba(15,23,42,0.06)] !bg-[hsl(230,1%,98%)]"
                : "my-2 rounded-lg border border-slate-700/50 !bg-[#1E1E1E]",
            )}
            customStyle={
              soft
                ? {
                    margin: 0,
                    padding: "1rem 1.05rem",
                    fontSize: "13px",
                    lineHeight: 1.55,
                  }
                : undefined
            }
          >
            {text}
          </SyntaxHighlighter>
        );
      }
      return (
        <code
          {...props}
          className={cn(
            "rounded bg-slate-100/80 px-1 py-0.5 font-mono text-[0.9em]",
            className,
          )}
        >
          {children}
        </code>
      );
    },
  };

  if (suppressCodeBlocks) {
    components.pre = ({ children }) => <>{children}</>;
  }

  return (
    <Markdown remarkPlugins={[remarkGfm]} components={components}>
      {content}
    </Markdown>
  );
}
