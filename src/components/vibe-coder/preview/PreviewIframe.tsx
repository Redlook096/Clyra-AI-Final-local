import { forwardRef } from "react";
import { cn } from "../../../lib/utils";
import { ElectronWebContentsSurface } from "../../ElectronWebContentsSurface";
import { isElectronRuntime } from "../../../lib/electron-runtime";

export const PreviewIframe = forwardRef<
  HTMLIFrameElement,
  {
    src: string;
    title: string;
    className?: string;
    onLoad?: () => void;
  }
>(function PreviewIframe({ src, title, className, onLoad }, ref) {
  if (isElectronRuntime()) {
    return (
      <ElectronWebContentsSurface
        source={src}
        title={title}
        surfaceId="project-preview"
        kind="preview"
        className={className}
        fallback={
          <iframe
            src={src}
            title={title}
            onLoad={onLoad}
            className={cn("h-full w-full border-0 bg-white", className)}
            sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
            allow="clipboard-read; clipboard-write"
          />
        }
      />
    );
  }
  return (
    <iframe
      ref={ref}
      src={src}
      title={title}
      onLoad={onLoad}
      className={cn("h-full w-full border-0 bg-white", className)}
      sandbox="allow-forms allow-modals allow-popups allow-same-origin allow-scripts"
      allow="clipboard-read; clipboard-write"
    />
  );
});
