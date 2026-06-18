import type { ReactNode } from "react";
import { NetworkMotionBackground } from "./NetworkMotionBackground";

export type ThemeMode = "light" | "dark";
export type JourneyState = "idle" | "launch" | "settled";

export function AppShell({
  children,
  journeyState = "idle",
  theme
}: Readonly<{
  children: ReactNode;
  journeyState?: JourneyState;
  theme: ThemeMode;
}>) {
  return (
    <div className={`app-shell theme-${theme} relative min-h-screen overflow-hidden`}>
      <NetworkMotionBackground journeyState={journeyState} theme={theme} />
      <div className="top-sheen pointer-events-none absolute inset-x-0 top-0 h-28" />
      <div className="relative z-10">{children}</div>
    </div>
  );
}
