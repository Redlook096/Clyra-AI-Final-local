import { cn } from "../../lib/utils";

/** Official Google Workspace product logos (gstatic). */
export const GOOGLE_PRODUCT_LOGOS = {
  google: "https://www.gstatic.com/images/branding/product/2x/googleg_48dp.png",
  gmail: "https://www.gstatic.com/images/branding/product/2x/gmail_48dp.png",
  calendar: "https://www.gstatic.com/images/branding/product/2x/calendar_48dp.png",
  docs: "https://www.gstatic.com/images/branding/product/2x/docs_48dp.png",
  sheets: "https://www.gstatic.com/images/branding/product/2x/sheets_48dp.png",
  slides: "https://www.gstatic.com/images/branding/product/2x/slides_48dp.png",
  drive: "https://www.gstatic.com/images/branding/product/2x/drive_48dp.png",
} as const;

export type GoogleProductId = keyof typeof GOOGLE_PRODUCT_LOGOS;

export function GoogleProductIcon({
  product = "google",
  className = "h-4 w-4",
}: {
  product?: GoogleProductId;
  className?: string;
}) {
  return (
    <img
      src={GOOGLE_PRODUCT_LOGOS[product]}
      alt=""
      draggable={false}
      className={cn("object-contain", className)}
    />
  );
}

/** Official YouTube play-button mark (brand red + white triangle). */
export function YouTubeBrandIcon({ className = "h-4 w-4" }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden focusable="false">
      <path
        fill="#FF0000"
        d="M23.5 6.2a3.02 3.02 0 0 0-2.12-2.14C19.4 3.5 12 3.5 12 3.5s-7.4 0-9.38.56A3.02 3.02 0 0 0 .5 6.2 31.4 31.4 0 0 0 0 12a31.4 31.4 0 0 0 .5 5.8 3.02 3.02 0 0 0 2.12 2.14C4.6 20.5 12 20.5 12 20.5s7.4 0 9.38-.56a3.02 3.02 0 0 0 2.12-2.14A31.4 31.4 0 0 0 24 12a31.4 31.4 0 0 0-.5-5.8z"
      />
      <path fill="#fff" d="M9.75 15.52V8.48L16.5 12l-6.75 3.52z" />
    </svg>
  );
}
