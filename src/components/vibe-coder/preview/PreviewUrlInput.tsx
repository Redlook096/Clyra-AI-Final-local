import { type FormEvent } from "react";

export function normalizePreviewAddress(input: string) {
  const trimmed = input.trim();
  if (!trimmed) return "";
  if (/^https?:\/\//i.test(trimmed)) return trimmed;
  if (/^(localhost|127\.0\.0\.1)(:\d+)?/i.test(trimmed)) {
    return `http://${trimmed}`;
  }
  if (/^[\w.-]+\.[a-z]{2,}(\/.*)$/i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return `https://www.bing.com/search?q=${encodeURIComponent(trimmed)}`;
}

export function PreviewUrlInput({
  value,
  onChange,
  onNavigate,
  placeholder = "Enter a route or URL",
}: {
  value: string;
  onChange: (value: string) => void;
  onNavigate: (value: string) => void;
  placeholder?: string;
}) {
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const url = normalizePreviewAddress(value);
    if (url) onNavigate(url);
  };

  return (
    <form onSubmit={submit} className="min-w-0 flex-1">
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        placeholder={placeholder}
        spellCheck={false}
        autoComplete="off"
        aria-label="Preview address"
        className="h-8 w-full rounded-[10px] border border-slate-200/80 bg-[#f8fafc] px-3 text-[12.5px] font-medium text-slate-700 outline-none transition-[border-color,background-color,box-shadow] duration-150 placeholder:text-slate-400 hover:border-slate-300 focus:border-slate-300 focus:bg-white focus:shadow-[0_0_0_3px_rgba(148,163,184,0.12)]"
      />
    </form>
  );
}
