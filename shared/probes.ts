export interface ProbeLocation {
  id: string;
  label: string;
  city: string;
  country: string;
}

// Every entry is a Globalping city with 20+ probes, so an explicit pick keeps resolving
// even when individual probes drop out. Verified against GET /v1/probes.
export const PROBE_LOCATIONS: readonly ProbeLocation[] = [
  { id: "seoul", label: "Seoul", city: "Seoul", country: "KR" },
  { id: "tokyo", label: "Tokyo", city: "Tokyo", country: "JP" },
  { id: "hongkong", label: "Hong Kong", city: "Hong Kong", country: "HK" },
  { id: "singapore", label: "Singapore", city: "Singapore", country: "SG" },
  { id: "taipei", label: "Taipei", city: "Taipei", country: "TW" },
  { id: "sydney", label: "Sydney", city: "Sydney", country: "AU" },
  { id: "mumbai", label: "Mumbai", city: "Mumbai", country: "IN" },
  { id: "frankfurt", label: "Frankfurt", city: "Frankfurt", country: "DE" },
  { id: "amsterdam", label: "Amsterdam", city: "Amsterdam", country: "NL" },
  { id: "london", label: "London", city: "London", country: "GB" },
  { id: "paris", label: "Paris", city: "Paris", country: "FR" },
  { id: "newyork", label: "New York", city: "New York", country: "US" },
  { id: "losangeles", label: "Los Angeles", city: "Los Angeles", country: "US" },
  { id: "saopaulo", label: "São Paulo", city: "Sao Paulo", country: "BR" }
];

export function countryFlag(country: string) {
  const REGIONAL_INDICATOR_A = 0x1f1e6;

  return String.fromCodePoint(
    ...[...country.toUpperCase()].map((letter) => REGIONAL_INDICATOR_A + letter.charCodeAt(0) - 65)
  );
}

export function findProbeLocation(id: unknown): ProbeLocation | undefined {
  return typeof id === "string" ? PROBE_LOCATIONS.find((probe) => probe.id === id) : undefined;
}
