import { StrictMode, lazy, Suspense, Component, type ErrorInfo, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import App from "./App.tsx";
import "./index.css";

class RootErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("App crashed:", error, info.componentStack);
  }

  render() {
    if (this.state.error) {
      return (
        <div className="min-h-dvh flex items-center justify-center bg-slate-50 p-6 text-slate-800">
          <div className="max-w-lg rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
            <h1 className="text-lg font-semibold text-slate-900">Something went wrong</h1>
            <p className="mt-2 text-sm text-slate-600">
              The app hit a runtime error. Check the browser console for details. Make sure{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">DEEPSEEK_API_KEY</code> is set in{" "}
              <code className="rounded bg-slate-100 px-1 py-0.5 font-mono text-xs">.env.local</code> for chat and title generation.
            </p>
            <pre className="mt-4 max-h-40 overflow-auto rounded-lg bg-slate-900 p-3 text-xs text-slate-100">
              {this.state.error.message}
            </pre>
            <button
              type="button"
              className="mt-4 rounded-full bg-slate-900 px-4 py-2 text-sm font-medium text-white hover:bg-slate-800"
              onClick={() => window.location.reload()}
            >
              Reload
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

const rootElement = document.getElementById("root")!;
const rootHost = window as Window & {
  __clyraRoot?: ReturnType<typeof createRoot>;
};
const root = rootHost.__clyraRoot ?? createRoot(rootElement);
rootHost.__clyraRoot = root;

const embedParams = new URLSearchParams(window.location.search);
if (embedParams.get("vibe_embed") === "1") {
  void import("./vibe-embed.tsx").then((m) => {
    /* No StrictMode: double mount would re-run Babel preview boot twice in the embed iframe. */
    root.render(<m.default />);
  });
} else if (window.location.pathname === "/preview") {
  const searchParams = new URLSearchParams(window.location.search);
  const theme = searchParams.get("theme");
  if (theme) {
    document.body.className = `theme-${theme} bg-transparent`;
  }

  const importUrl = `/src/GeneratedPreviewComponent.tsx?t=${Date.now()}`;

  import(/* @vite-ignore */ importUrl)
    .then((module) => {
      const Component = module.default;
      root.render(
        <StrictMode>
          <Suspense
            fallback={
              <div className="flex min-h-[300px] w-full items-center justify-center text-stone-400">
                Loading Preview...
              </div>
            }
          >
            <Component />
          </Suspense>
        </StrictMode>,
      );
    })
    .catch((err) => {
      console.error("Preview render error:", err);
      root.render(
        <div className="m-4 rounded-xl border border-red-200 bg-red-50 p-6 text-red-600 shadow-sm">
          <h3 className="mb-2 font-bold">Preview Error</h3>
          <pre className="font-mono text-sm whitespace-pre-wrap">{err?.toString()}</pre>
        </div>,
      );
    });
} else {
  root.render(
    <StrictMode>
      <RootErrorBoundary>
        <Suspense fallback={
          <div className="min-h-dvh flex items-center justify-center bg-slate-50 p-6 text-slate-800">
            <div className="text-center">
              <div className="w-16 h-16 mx-auto mb-4 rounded-full bg-slate-200 animate-pulse"></div>
              <p className="text-sm text-slate-600">Loading Clyra AI...</p>
            </div>
          </div>
        }>
          <App />
        </Suspense>
      </RootErrorBoundary>
    </StrictMode>,
  );
}
