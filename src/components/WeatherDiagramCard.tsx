import { useMemo, useState } from "react";
import { cn } from "../lib/utils";

export type WeatherDay = {
  date: string;
  highC: number;
  lowC: number;
  precipProb: number;
  weatherCode: number;
  condition: string;
};

export type WeatherPayload = {
  location: string;
  region?: string;
  country?: string;
  timezone?: string;
  observedAt?: string;
  matchedFrom?: string;
  current: {
    tempC: number;
    weatherCode: number;
    isDay: boolean;
    highC: number;
    lowC: number;
    precipProb: number;
    condition: string;
  };
  daily: WeatherDay[];
};

function weatherIcon(code: number, isDay: boolean, size: "lg" | "sm" = "sm") {
  const dim = size === "lg" ? "h-14 w-14" : "h-5 w-5";
  if (code === 0) {
    return isDay ? (
      <svg viewBox="0 0 24 24" className={cn(dim, "text-amber-500")} fill="currentColor" aria-hidden>
        <circle cx="12" cy="12" r="4.2" />
        <g stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" fill="none">
          <path d="M12 2.8v2.2M12 19v2.2M2.8 12h2.2M19 12h2.2M5.2 5.2l1.6 1.6M17.2 17.2l1.6 1.6M5.2 18.8l1.6-1.6M17.2 6.8l1.6-1.6" />
        </g>
      </svg>
    ) : (
      <svg viewBox="0 0 24 24" className={cn(dim, "text-sky-500")} fill="currentColor" aria-hidden>
        <path d="M16.4 4.2a7.6 7.6 0 1 0 3.4 14.4 8.8 8.8 0 1 1-3.4-14.4z" />
      </svg>
    );
  }
  if (code <= 3) {
    return (
      <svg viewBox="0 0 24 24" className={cn(dim, "text-slate-400")} fill="currentColor" aria-hidden>
        <path d="M7.5 18.5h9.2a4.3 4.3 0 0 0 .4-8.6 5.6 5.6 0 0 0-10.7 1.5A3.8 3.8 0 0 0 7.5 18.5z" />
      </svg>
    );
  }
  if (code <= 48) {
    return (
      <svg viewBox="0 0 24 24" className={cn(dim, "text-slate-400")} fill="none" stroke="currentColor" strokeWidth="1.7" aria-hidden>
        <path d="M3 9h18M4 13h16M6 17h12" strokeLinecap="round" />
      </svg>
    );
  }
  if (code <= 67 || (code >= 80 && code <= 82)) {
    return (
      <svg viewBox="0 0 24 24" className={cn(dim, "text-sky-500")} fill="currentColor" aria-hidden>
        <path d="M7.5 15.2h9.2a4.3 4.3 0 0 0 .4-8.6 5.6 5.6 0 0 0-10.7 1.5 3.8 3.8 0 0 0 1.1 7.1z" />
        <g fill="none" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round">
          <path d="M9 17.4v2.2M12 18v2.4M15 17.4v2.2" />
        </g>
      </svg>
    );
  }
  if (code <= 77 || (code >= 85 && code <= 86)) {
    return (
      <svg viewBox="0 0 24 24" className={cn(dim, "text-sky-400")} fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden>
        <path d="M12 4v16M5.5 7.5l13 9M18.5 7.5l-13 9" strokeLinecap="round" />
      </svg>
    );
  }
  return (
    <svg viewBox="0 0 24 24" className={cn(dim, "text-amber-500")} fill="currentColor" aria-hidden>
      <path d="M13.2 2.5 6.8 13.2h4.2l-1.4 8.3 7.8-12.2h-4.4z" />
    </svg>
  );
}

function formatDayLabel(isoDate: string, index: number) {
  if (index === 0) return "Today";
  if (index === 1) return "Tomorrow";
  const d = new Date(`${isoDate}T12:00:00`);
  if (Number.isNaN(d.getTime())) return isoDate;
  return d.toLocaleDateString(undefined, { weekday: "short" });
}

export function WeatherDiagramCard({
  weather,
  className,
}: {
  weather: WeatherPayload;
  className?: string;
}) {
  const [unit, setUnit] = useState<"C" | "F">("C");

  const convert = (c: number) =>
    unit === "C" ? Math.round(c) : Math.round((c * 9) / 5 + 32);

  const dayLabel = useMemo(() => {
    const d = weather.observedAt ? new Date(weather.observedAt) : new Date();
    return d.toLocaleDateString(undefined, { weekday: "long" });
  }, [weather.observedAt]);

  const place = [weather.location, weather.region, weather.country]
    .filter(Boolean)
    .join(", ");

  const days = weather.daily?.length
    ? weather.daily
    : [
        {
          date: weather.observedAt?.slice(0, 10) || new Date().toISOString().slice(0, 10),
          highC: weather.current.highC,
          lowC: weather.current.lowC,
          precipProb: weather.current.precipProb,
          weatherCode: weather.current.weatherCode,
          condition: weather.current.condition,
        },
      ];

  return (
    <div
      className={cn(
        "my-2 w-full max-w-xl overflow-hidden rounded-[22px] border border-slate-200/80 bg-white/90 px-5 py-4 shadow-[0_18px_40px_rgba(15,23,42,0.05)]",
        className,
      )}
      data-invert-ignore
    >
      <p className="text-[13px] font-medium tracking-[-0.01em] text-slate-500">
        {dayLabel} · {place}
      </p>
      {weather.matchedFrom ? (
        <p className="mt-1 text-[11.5px] font-medium text-slate-400">
          Matched from “{weather.matchedFrom}”
        </p>
      ) : null}

      <div className="mt-4 flex flex-wrap items-start justify-between gap-6">
        <div className="flex items-center gap-4">
          {weatherIcon(weather.current.weatherCode, weather.current.isDay, "lg")}
          <div>
            <div className="flex items-end gap-2">
              <span className="text-[56px] font-light leading-none tracking-[-0.04em] text-slate-900">
                {convert(weather.current.tempC)}
              </span>
              <div className="mb-2 flex items-center gap-1.5 text-[13px] font-medium text-slate-400">
                <button
                  type="button"
                  onClick={() => setUnit("C")}
                  className={cn(
                    "transition-colors",
                    unit === "C" ? "text-slate-800" : "hover:text-slate-600",
                  )}
                >
                  °C
                </button>
                <span className="text-slate-300">|</span>
                <button
                  type="button"
                  onClick={() => setUnit("F")}
                  className={cn(
                    "transition-colors",
                    unit === "F" ? "text-slate-800" : "hover:text-slate-600",
                  )}
                >
                  °F
                </button>
              </div>
            </div>
            <p className="mt-1 text-[16px] font-semibold tracking-[-0.02em] text-slate-800">
              {weather.current.condition}
            </p>
            <p className="mt-1 text-[12.5px] font-medium text-slate-500">
              High {convert(weather.current.highC)}° · Low{" "}
              {convert(weather.current.lowC)}° · Precip{" "}
              {Math.round(weather.current.precipProb)}%
            </p>
          </div>
        </div>
      </div>

      <div className="mt-5 overflow-x-auto pb-1 [-ms-overflow-style:none] [scrollbar-width:thin]">
        <div className="flex min-w-max gap-3 px-0.5">
          {days.map((day, index) => (
            <div
              key={day.date}
              className="flex w-[58px] flex-col items-center gap-1.5 rounded-2xl px-1 py-1 text-center"
            >
              <span className="text-[11px] font-medium text-slate-500">
                {formatDayLabel(day.date, index)}
              </span>
              {weatherIcon(day.weatherCode, true, "sm")}
              <span className="text-[11px] font-semibold text-sky-500">
                {Math.round(day.precipProb)}%
              </span>
              <div className="flex flex-col items-center leading-tight">
                <span className="text-[13px] font-semibold text-slate-800">
                  {convert(day.highC)}°
                </span>
                <span className="text-[12px] font-medium text-slate-400">
                  {convert(day.lowC)}°
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
