import LiquidGlass from "liquid-glass-react";
import { motion } from "framer-motion";
import type { ReactNode } from "react";

type LiquidGlassButtonProps = {
  icon: ReactNode;
  label: string;
  onClick: () => void;
  active?: boolean;
  danger?: boolean;
};

/** Circular Liquid Glass call control (mic, end-call). */
export function LiquidGlassButton({ icon, label, onClick, active, danger }: LiquidGlassButtonProps) {
  return (
    <motion.button
      type="button"
      aria-label={label}
      onClick={onClick}
      whileHover={{ scale: 1.06 }}
      whileTap={{ scale: 0.92 }}
      transition={{ type: "spring", stiffness: 420, damping: 24 }}
      className="relative"
    >
      <LiquidGlass
        cornerRadius={999}
        padding="18px"
        blurAmount={14}
        saturation={140}
        aberrationIntensity={danger ? 1.4 : 0.8}
        elasticity={0.18}
        mode="standard"
        overLight={active}
        className={danger ? "voice-glass-danger" : active ? "voice-glass-active" : ""}
      >
        <span className="flex h-6 w-6 items-center justify-center text-white/90">{icon}</span>
      </LiquidGlass>
    </motion.button>
  );
}
