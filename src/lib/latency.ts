// Colour by how fast the packet crossed a leg, the convention geotraceroute uses: the leg's
// drawn distance over half the round-trip increase between its two ends, in km/s, against
// the speed of light in fibre (about 200,000 km/s). A leg that runs near that limit is
// green; one that took far longer than its length explains - a detour, a queue - goes
// through yellow and orange to red. Short legs are judged leniently: over a few hundred
// kilometres the round trip is mostly per-hop processing and jitter, not propagation. No
// increase in round-trip time, or no reply, means the speed cannot be measured, and that
// is a neutral grey rather than either end of the scale. Six-digit hex only - the globe
// appends an alpha byte for its fading rings.
export const NO_SPEED = { dark: "#8b949e", light: "#6b7280" } as const;

// The globe marks the route's two ends the way an instrument marks them, not the way a
// highlighter does: the dot and the name in the page's own black and white, with no colour
// of their own. What sets an end apart there is the light drawn around it.
export const ENDPOINT_INK = { dark: "#ffffff", light: "#0b1220" } as const;

// The flat map marks its two ends the plain way, in colour, as it did before the globe took
// to marking its own with a glow instead.
export const ENDPOINT = {
  dark: { source: "#38bdf8", target: "#c084fc" },
  light: { source: "#0369a1", target: "#7e22ce" }
} as const;

const STOPS: Record<"light" | "dark", Array<[number, string]>> = {
  dark: [
    [0, "#ff4d4d"],
    [40_000, "#ff9e2c"],
    [90_000, "#ffe14d"],
    [150_000, "#8adc4e"],
    [210_000, "#2fd65e"]
  ],
  // By day the very same neon: muted day tones, and then deeper ones, both read as a dark
  // line beside the cables. The globe lightens the line further on top of these.
  light: [
    [0, "#ff4d4d"],
    [40_000, "#ff9e2c"],
    [90_000, "#ffe14d"],
    [150_000, "#8adc4e"],
    [210_000, "#2fd65e"]
  ]
};

const LENIENCY_REF_KM = 1500;


// The legend's word for a speed: the same cuts the colour scale turns on.
export function speedBand(kmps: number): "slow" | "average" | "fast" {
  return kmps < 70_000 ? "slow" : kmps < 140_000 ? "average" : "fast";
}

// km/s for a leg, or undefined when the round trip did not grow across it.
export function segmentSpeed(km: number, rttIncreaseMs: number | undefined) {
  if (rttIncreaseMs === undefined || Number.isNaN(rttIncreaseMs) || rttIncreaseMs <= 0 || !Number.isFinite(km) || km <= 0) {
    return undefined;
  }

  const kmps = (km * 2000) / rttIncreaseMs;

  return kmps * (1 + LENIENCY_REF_KM / km);
}

function mix(from: string, to: string, t: number) {
  const channel = (offset: number) => {
    const a = Number.parseInt(from.slice(offset, offset + 2), 16);
    const b = Number.parseInt(to.slice(offset, offset + 2), 16);

    return Math.round(a + (b - a) * t).toString(16).padStart(2, "0");
  };

  return `#${channel(1)}${channel(3)}${channel(5)}`;
}

export function speedColor(kmps: number | undefined, theme: "light" | "dark") {
  if (kmps === undefined || !Number.isFinite(kmps) || kmps <= 0) {
    return NO_SPEED[theme];
  }

  const stops = STOPS[theme];

  for (let index = 1; index < stops.length; index += 1) {
    if (kmps <= stops[index][0]) {
      const [fromSpeed, fromColor] = stops[index - 1];
      const [toSpeed, toColor] = stops[index];

      return mix(fromColor, toColor, (kmps - fromSpeed) / (toSpeed - fromSpeed));
    }
  }

  return (stops.at(-1) ?? stops[0])[1];
}

// The hot centre of a neon line: the leg colour pulled toward white.
export function lighten(hex: string, amount: number) {
  return mix(hex, "#ffffff", amount);
}

export function speedGradient(theme: "light" | "dark") {
  const stops = STOPS[theme];
  const max = (stops.at(-1) ?? stops[0])[0];

  return `linear-gradient(90deg, ${stops.map(([speed, color]) => `${color} ${((100 * speed) / max).toFixed(1)}%`).join(", ")})`;
}
