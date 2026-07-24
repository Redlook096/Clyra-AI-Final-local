export type OrbColorTheme = "default" | "ocean" | "sunset" | "forest" | "mono" | "noir";

const ORB_THEMES: Record<OrbColorTheme, { gradient: string; halo: string; ring: string; introA: string; introB: string; introC: string; introD: string; }> = {
  default: {
    gradient: "conic-gradient(from 45deg, #3b82f6, #2563eb, #22d3ee, #8b5cf6, #3b82f6)",
    halo: "radial-gradient(circle, rgba(96, 165, 250, 0.22) 0%, rgba(45, 212, 191, 0.16) 28%, rgba(139, 92, 246, 0.1) 48%, transparent 72%)",
    ring: "linear-gradient(white, #38bdf8, #6366f1, #c4b5fd) border-box",
    introA: "59 130 246",
    introB: "34 211 238",
    introC: "139 92 246",
    introD: "125 211 252",
  },
  ocean: {
    gradient: "conic-gradient(from 45deg, #0c4a6e, #0284c7, #06b6d4, #0ea5e9, #0c4a6e)",
    halo: "radial-gradient(circle, rgba(2, 132, 199, 0.22) 0%, rgba(6, 182, 212, 0.16) 28%, rgba(14, 165, 233, 0.1) 48%, transparent 72%)",
    ring: "linear-gradient(white, #0284c7, #06b6d4, #0ea5e9) border-box",
    introA: "2 132 199",
    introB: "6 182 212",
    introC: "14 165 233",
    introD: "186 230 253",
  },
  sunset: {
    gradient: "conic-gradient(from 45deg, #7c2d12, #ea580c, #f472b6, #a855f7, #7c2d12)",
    halo: "radial-gradient(circle, rgba(234, 88, 12, 0.22) 0%, rgba(244, 114, 182, 0.16) 28%, rgba(168, 85, 247, 0.1) 48%, transparent 72%)",
    ring: "linear-gradient(white, #ea580c, #f472b6, #a855f7) border-box",
    introA: "234 88 12",
    introB: "244 114 182",
    introC: "168 85 247",
    introD: "253 186 116",
  },
  forest: {
    gradient: "conic-gradient(from 45deg, #14532d, #16a34a, #2dd4bf, #059669, #14532d)",
    halo: "radial-gradient(circle, rgba(22, 163, 74, 0.22) 0%, rgba(45, 212, 191, 0.16) 28%, rgba(5, 150, 105, 0.1) 48%, transparent 72%)",
    ring: "linear-gradient(white, #16a34a, #2dd4bf, #059669) border-box",
    introA: "22 163 74",
    introB: "45 212 191",
    introC: "5 150 105",
    introD: "187 247 208",
  },
  mono: {
    gradient: "conic-gradient(from 45deg, #1e293b, #64748b, #cbd5e1, #94a3b8, #1e293b)",
    halo: "radial-gradient(circle, rgba(100, 116, 139, 0.22) 0%, rgba(203, 213, 225, 0.16) 28%, rgba(148, 163, 184, 0.1) 48%, transparent 72%)",
    ring: "linear-gradient(white, #64748b, #cbd5e1, #94a3b8) border-box",
    introA: "100 116 139",
    introB: "203 213 225",
    introC: "148 163 184",
    introD: "241 245 249",
  },
  noir: {
    gradient: "conic-gradient(from 45deg, #000000, #333333, #ffffff, #111111, #000000)",
    halo: "radial-gradient(circle, rgba(255, 255, 255, 0.18) 0%, rgba(150, 150, 150, 0.1) 28%, rgba(50, 50, 50, 0.05) 48%, transparent 72%)",
    ring: "linear-gradient(white, #555555, #aaaaaa, #222222) border-box",
    introA: "51 51 51",
    introB: "170 170 170",
    introC: "255 255 255",
    introD: "17 17 17",
  }
};

interface AiOrbProps {
  colorTheme?: OrbColorTheme;
  introActive?: boolean;
}

export function AiOrb({ colorTheme = "default", introActive = false }: AiOrbProps) {
  const theme = ORB_THEMES[colorTheme];

  return (
    <div 
      className={`clyra-ai-orb-shell${introActive ? " clyra-ai-orb-shell--intro" : ""}`}
      aria-hidden="true"
      style={{
        "--orb-halo-bg": theme.halo,
        "--orb-ring-bg": theme.ring,
        "--orb-intro-a": theme.introA,
        "--orb-intro-b": theme.introB,
        "--orb-intro-c": theme.introC,
        "--orb-intro-d": theme.introD,
      } as React.CSSProperties}
    >
      <div className="clyra-ai-orb">

        <span
          className="clyra-ai-orb-ball"
          style={{ background: theme.gradient }}
        >
          <span className="clyra-ai-orb-lines" />
          <span className="clyra-ai-orb-rings" />
          <span className="clyra-ai-orb-glow" />
          <span className="clyra-ai-orb-front" />
        </span>
        <svg className="clyra-ai-orb-filter" focusable="false">
          <filter
            id="clyra-ai-orb-gooey"
            x="-80%"
            y="-80%"
            width="260%"
            height="260%"
            colorInterpolationFilters="sRGB"
          >
            <feGaussianBlur in="SourceGraphic" stdDeviation="4.5" />
            <feColorMatrix
              values="1 0 0 0 0
              0 1 0 0 0
              0 0 1 0 0
              0 0 0 18 -8"
            />
          </filter>
        </svg>
      </div>
    </div>
  );
}
