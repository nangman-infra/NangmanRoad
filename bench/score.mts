import { readdirSync, readFileSync } from "node:fs";

// Complete GeoIP answers are kept in bench/geo-cache.json, so a run costs the free tiers
// nothing after the first and scores the rules, not the providers' mood that minute.
process.env.GEO_CACHE_FILE ??= new URL("geo-cache.json", import.meta.url).pathname;
// A scoring run is not a sighting: nothing it places goes on the site-code candidate list.
process.env.SITE_CODE_CANDIDATES_FILE ??= "off";
import { parseRawTraceroute } from "../server/providers/globalpingProvider";
import { enrichHopsWithGeo } from "../server/geoInference";

// Light in single-mode fibre: c divided by the group index of SMF-28 at 1550 nm.
const FIBRE_KM_PER_S = 299_792.458 / 1.4682;
const EARTH_RADIUS_KM = 6371;
const radians = (degrees: number) => (degrees * Math.PI) / 180;

function distanceKm(a: { lat: number; lon: number }, b: { lat: number; lon: number }) {
  const dLat = radians(b.lat - a.lat);
  const dLon = radians(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 + Math.cos(radians(a.lat)) * Math.cos(radians(b.lat)) * Math.sin(dLon / 2) ** 2;

  return 2 * EARTH_RADIUS_KM * Math.asin(Math.sqrt(h));
}

const truth = JSON.parse(readFileSync(new URL("truth.json", import.meta.url), "utf8")) as {
  codes: [string, string, string][];
  sameMetro: [string, string][];
};
const codes = truth.codes.map(([pattern, city]) => [new RegExp(pattern), city] as const);
const alias = (city: string) =>
  truth.sameMetro.find(([from]) => from.toLowerCase() === city.toLowerCase())?.[1] ?? city;

function sameCity(claimed: string, expected: string) {
  const [a, b] = [alias(claimed).toLowerCase(), alias(expected).toLowerCase()];

  return a.includes(b) || b.includes(a);
}

const dir = new URL("traces/", import.meta.url);
const totals = { impossible: 0, routes: 0, hit: 0, miss: 0, blank: 0, placed: 0, addressed: 0 };

console.log("route".padEnd(30), "implied".padStart(9), "  ", "% of fibre".padStart(10), " placed");
console.log("-".repeat(70));

for (const file of readdirSync(dir).filter((name) => name.endsWith(".json")).sort()) {
  const entry = JSON.parse(readFileSync(new URL(file, dir), "utf8"));
  const hops = await enrichHopsWithGeo({
    hops: parseRawTraceroute(entry.raw),
    source: {
      provider: "globalping",
      city: entry.probe.city,
      country: entry.probe.country,
      latitude: entry.probe.latitude,
      longitude: entry.probe.longitude
    } as never
  });

  const placed = hops.filter((hop) => typeof hop.latitude === "number");
  const addressed = hops.filter((hop) => hop.ip);
  totals.placed += placed.length;
  totals.addressed += addressed.length;

  const lastRtt = placed.at(-1)?.rttMs;
  let speed: number | undefined;

  if (placed.length >= 2 && lastRtt) {
    const points = placed.map((hop) => ({ lat: hop.latitude as number, lon: hop.longitude as number }));
    const path = points.slice(1).reduce((sum, point, index) => sum + distanceKm(points[index], point), 0);
    speed = path / (lastRtt / 2 / 1000);
    totals.routes += 1;
    if (speed > FIBRE_KM_PER_S) totals.impossible += 1;
  }

  for (const line of entry.raw.split("\n").slice(1)) {
    const hostname = line.trim().split(/\s+/)[1] ?? "";
    const ip = line.match(/\((\d+\.\d+\.\d+\.\d+)\)/)?.[1];
    const expected = codes.find(([pattern]) => pattern.test(hostname))?.[1];

    if (!expected || !ip) continue;

    const claimed = hops.find((hop) => hop.ip === ip)?.city;

    if (!claimed) totals.blank += 1;
    else if (sameCity(claimed, expected)) totals.hit += 1;
    else {
      totals.miss += 1;
      console.log(`  ! ${file.replace(".json", "")} ${hostname} -> expected ${expected}, said ${claimed}`);
    }
  }

  console.log(
    file.replace(".json", "").padEnd(30),
    (speed ? Math.round(speed).toLocaleString() : "-").padStart(9),
    speed && speed > FIBRE_KM_PER_S ? "!!" : "  ",
    (speed ? `${Math.round((speed / FIBRE_KM_PER_S) * 100)}%` : "-").padStart(10),
    ` ${placed.length}/${addressed.length}`
  );
}

const named = totals.hit + totals.miss + totals.blank;
console.log(`\nfibre ceiling            ${Math.round(FIBRE_KM_PER_S).toLocaleString()} km/s`);
console.log(`physically impossible    ${totals.impossible}/${totals.routes} routes`);
console.log(`named-hop agreement      ${totals.hit}/${named}  (wrong ${totals.miss}, blank ${totals.blank})`);
console.log(`placement rate           ${totals.placed}/${totals.addressed} hops that answered`);
