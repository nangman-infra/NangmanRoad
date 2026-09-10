// Rebuilds the bundled data from its sources, so a refresh is one command and not a
// remembered afternoon:
//   public/data/cables.json, landings.json          TeleGeography Submarine Cable Map (CC BY-SA 4.0)
//   server/data/peeringdbCities.json, ixpPrefixes.json,
//   server/data/asOrgs.json                         PeeringDB - kept out of the repository: its
//                                                   acceptable use policy allows the data for
//                                                   troubleshooting but not passing it on in bulk
//   public/data/land.json                           Natural Earth 1:10m roads and railroads, through
//                                                   mapshaper and scripts/build-land-graph.mts
//   public/data/countries.json                      Natural Earth 1:50m countries, simplified by mapshaper
// cities.json (Natural Earth 1:10m places) is left alone: it changes once in years, and the
// README says how it was made.
//   npm run data:refresh                  everything
//   npm run data:refresh -- cables        one step: cables | peeringdb | land | borders
//   npm run data:refresh -- --fresh       download again instead of using .cache/data-refresh
// PEERINGDB_API_KEY, when set, is sent to PeeringDB; without it the anonymous limits apply
// and the fetch just takes longer.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const cacheDir = path.join(root, ".cache/data-refresh");
const args = process.argv.slice(2);
const fresh = args.includes("--fresh");
const steps = args.filter((arg) => !arg.startsWith("--"));
const wanted = (step: string) => steps.length === 0 || steps.includes(step);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const round = (value: number, places: number) => Math.round(value * 10 ** places) / 10 ** places;
const compact = (value: unknown) => JSON.stringify(value);

mkdirSync(cacheDir, { recursive: true });

// When the last live request went out, so a source's requests can be spaced under its limit.
// A cache hit above never counts: spacing is for the network, not the disk.
let lastFetchAt = 0;

async function download(url: string, file: string, init: RequestInit = {}, spacingMs = 0) {
  const target = path.join(cacheDir, file);

  if (!fresh && existsSync(target)) return readFileSync(target);

  for (let attempt = 1; ; attempt += 1) {
    try {
      await sleep(Math.max(0, lastFetchAt + spacingMs - Date.now()));
      lastFetchAt = Date.now();

      const response = await fetch(url, init);

      // A rate limit is not a hiccup: asking again is the same request, which is the thing
      // being limited, so say what lifts it instead of retrying into it.
      if (response.status === 429) {
        throw new Error("HTTP 429, rate limited: wait for the window to pass (PeeringDB: an hour for a repeated large request), or set an API key");
      }

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const body = Buffer.from(await response.arrayBuffer());

      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, body);

      return body;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      if (attempt === 4 || message.startsWith("HTTP 429")) throw new Error(`${url}: ${message}`);
      await sleep(3000 * attempt);
    }
  }
}

const fetchJson = async <T,>(url: string, file: string, init?: RequestInit, spacingMs?: number) =>
  JSON.parse((await download(url, file, init, spacingMs)).toString("utf8")) as T;

function write(file: string, value: unknown) {
  const target = path.join(root, file);

  mkdirSync(path.dirname(target), { recursive: true });

  writeFileSync(target, compact(value));
  console.log(`${file.padEnd(32)} ${(readFileSync(target).length / 1024).toFixed(0).padStart(6)} KB`);
}

// ---------------------------------------------------------------------------------------
// TeleGeography: every cable's line, simplified for the globe and the router, its owners
// for the router's owned-cable discount, and the landing stations by name.
async function refreshCables() {
  const TG = "https://www.submarinecablemap.com/api/v3";
  type Feature = { properties: { id: string; name: string; color: string }; geometry: { coordinates: number[][][] } };
  type Landing = { properties: { id: string; name: string; is_tbd: boolean | null }; geometry: { coordinates: [number, number] } };
  type Detail = { name?: string; owners?: string; rfs_year?: number | null; is_planned?: boolean | null };

  const geo = await fetchJson<{ features: Feature[] }>(`${TG}/cable/cable-geo.json`, "cable-geo.json");
  const landingPoints = await fetchJson<{ features: Landing[] }>(`${TG}/landing-point/landing-point-geo.json`, "landing-point-geo.json");
  const ids = [...new Set(geo.features.map((feature) => feature.properties.id))];
  const details = new Map<string, Detail>();
  let done = 0;

  // Six at a time: the site answers a few hundred small requests without complaint at that rate.
  await Promise.all(
    Array.from({ length: 6 }, async (_, lane) => {
      for (let index = lane; index < ids.length; index += 6) {
        details.set(ids[index], await fetchJson<Detail>(`${TG}/cable/${ids[index]}.json`, `cable/${ids[index]}.json`));
        done += 1;

        if (done % 100 === 0) console.log(`cable details ${done}/${ids.length}`);
      }
    })
  );

  const thisYear = new Date().getFullYear();
  const planned = new Set<string>();
  const owners = new Map<string, string>();

  for (const [id, detail] of details) {
    const name = detail.name ?? geo.features.find((feature) => feature.properties.id === id)?.properties.name ?? id;

    if (detail.is_planned || (typeof detail.rfs_year === "number" && detail.rfs_year > thisYear)) planned.add(name);
    if (detail.owners) owners.set(name, detail.owners);
  }

  // Coordinates to 0.01°, and a vertex closer than 0.15° to the last one kept is dropped,
  // the line's end excepted: the globe draws the shape, the router only needs the ends.
  const simplify = (line: number[][]) => {
    const kept: number[][] = [];

    line.forEach(([lng, lat], index) => {
      const point = [round(lng, 2), round(lat, 2)];
      const last = kept.at(-1);

      if (last && index < line.length - 1 && Math.hypot(point[0] - last[0], point[1] - last[1]) < 0.15) return;
      if (last && last[0] === point[0] && last[1] === point[1]) return;

      kept.push(point);
    });

    return kept;
  };

  write("public/data/cables.json", {
    _source: "TeleGeography Submarine Cable Map, https://www.submarinecablemap.com",
    _license:
      "CC BY-SA 4.0 - https://creativecommons.org/licenses/by-sa/4.0/ (simplified: coordinates rounded to 0.01 deg, points closer than 0.15 deg dropped) (planned systems not yet in service are left out)",
    type: "FeatureCollection",
    features: geo.features
      .filter((feature) => !planned.has(feature.properties.name))
      .map((feature) => ({
        type: "Feature",
        properties: {
          name: feature.properties.name,
          color: feature.properties.color,
          ...(owners.has(feature.properties.name) ? { owners: owners.get(feature.properties.name) } : {})
        },
        geometry: { type: "MultiLineString", coordinates: feature.geometry.coordinates.map(simplify) }
      }))
  });
  write("public/data/landings.json", {
    _source: "TeleGeography Submarine Cable Map, https://www.submarinecablemap.com",
    _license: "CC BY-SA 4.0",
    _format: "[name, lat, lng]",
    landings: landingPoints.features
      .filter((feature) => !feature.properties.is_tbd)
      .map((feature) => [feature.properties.name, round(feature.geometry.coordinates[1], 3), round(feature.geometry.coordinates[0], 3)])
  });
  console.log(`cables: ${geo.features.length} lines, ${planned.size} planned systems left out, ${owners.size} with owners`);
}

// ---------------------------------------------------------------------------------------
// PeeringDB: where each network has a documented point of presence, which exchange point
// each peering-LAN prefix belongs to, and each network's organisation.
async function refreshPeeringDb() {
  const PDB = "https://www.peeringdb.com/api";
  const key = process.env.PEERINGDB_API_KEY?.trim();
  const headers = key ? { Authorization: `Api-Key ${key}` } : undefined;
  // PeeringDB's published limits (docs.peeringdb.com, "Work within PeeringDB's query limits"):
  // 20 requests a minute anonymous, 40 with a key, and a repeated anonymous request over
  // 100 KB once an hour. Every page here is over 100 KB, so a run must never ask twice (the
  // cache) and must stay under the minute limit (the spacing).
  const spacingMs = key ? 2_000 : 4_000;

  async function pages<T>(endpoint: string, fields: string) {
    const rows: T[] = [];

    for (let skip = 0; ; skip += 5000) {
      const page = await fetchJson<{ data: T[] }>(`${PDB}/${endpoint}?limit=5000&skip=${skip}&fields=${fields}`, `pdb-${endpoint}-${skip}.json`, { headers }, spacingMs);

      rows.push(...page.data);
      console.log(`peeringdb ${endpoint} ${rows.length}`);

      if (page.data.length < 5000) return rows;
    }
  }

  type Facility = { id: number; city?: string; country?: string; latitude?: number | null; longitude?: number | null };
  const netfac = await pages<{ local_asn: number; city?: string; country?: string }>("netfac", "local_asn,city,country");
  const facilities = await pages<Facility>("fac", "id,city,country,latitude,longitude");
  const ixpfx = await pages<{ ixlan_id: number; prefix: string; protocol: string }>("ixpfx", "ixlan_id,prefix,protocol");
  const ixlan = await pages<{ id: number; ix_id: number }>("ixlan", "id,ix_id");
  const ix = await pages<{ id: number; name: string; city?: string; country?: string }>("ix", "id,name,city,country");
  const ixfac = await pages<{ ix_id: number; fac_id: number }>("ixfac", "ix_id,fac_id");
  const net = await pages<{ asn?: number; name?: string; aka?: string; org_id?: number }>("net", "asn,name,aka,org_id");
  const org = await pages<{ id: number; name: string }>("org", "id,name");

  const placed = facilities.filter((facility): facility is Facility & { latitude: number; longitude: number } => typeof facility.latitude === "number" && typeof facility.longitude === "number");
  const cityKey = (city?: string, country?: string) => `${(city ?? "").trim().toLowerCase()}|${(country ?? "").toUpperCase()}`;
  const centres = new Map<string, number[][]>();

  for (const facility of placed) {
    if (!facility.city) continue;

    const entry = centres.get(cityKey(facility.city, facility.country)) ?? [];

    entry.push([facility.latitude, facility.longitude]);
    centres.set(cityKey(facility.city, facility.country), entry);
  }

  const centre = (points: number[][]) => [points.reduce((sum, [lat]) => sum + lat, 0) / points.length, points.reduce((sum, [, lng]) => sum + lng, 0) / points.length];

  // Networks: every city they have a facility in, at the mean of that city's facilities.
  const byAsn = new Map<number, Map<string, (string | number)[]>>();
  let unmatched = 0;

  for (const row of netfac) {
    const key = cityKey(row.city, row.country);
    const points = centres.get(key);

    if (!points) {
      unmatched += 1;
      continue;
    }

    const [lat, lng] = centre(points);
    const cities = byAsn.get(row.local_asn) ?? new Map();

    cities.set(key, [round(lat, 2), round(lng, 2), (row.city ?? "").trim(), key.split("|")[1]]);
    byAsn.set(row.local_asn, cities);
  }

  write("server/data/peeringdbCities.json", Object.fromEntries([...byAsn].map(([asn, cities]) => [String(asn), [...cities.values()]])));

  // Exchange prefixes: at the mean of the exchange's facilities, or of its city's.
  const facilityById = new Map(placed.map((facility) => [facility.id, facility]));
  const exchangeFacilities = new Map<number, number[][]>();

  for (const row of ixfac) {
    const facility = facilityById.get(row.fac_id);

    if (facility) exchangeFacilities.set(row.ix_id, [...(exchangeFacilities.get(row.ix_id) ?? []), [facility.latitude, facility.longitude]]);
  }

  // An exchange's city as the hop placement spells cities: one name, no "/State", no accents.
  const cleanCity = (city: string) => city.split("/")[0].trim().normalize("NFKD").replace(/[^\x00-\x7f]/g, "");
  const exchangeById = new Map(ix.map((exchange) => [exchange.id, exchange]));
  const lanToExchange = new Map(ixlan.map((lan) => [lan.id, lan.ix_id]));
  const prefixes: (string | number)[][] = [];
  let skipped = 0;

  for (const prefix of ixpfx) {
    const exchange = exchangeById.get(lanToExchange.get(prefix.ixlan_id) ?? -1);
    const points = exchange ? exchangeFacilities.get(exchange.id) ?? (exchange.city ? centres.get(cityKey(exchange.city, exchange.country)) : undefined) : undefined;

    if (!exchange || !points) {
      skipped += 1;
      continue;
    }

    const [lat, lng] = centre(points);

    prefixes.push([prefix.prefix, round(lat, 3), round(lng, 3), exchange.name, cleanCity(exchange.city ?? ""), (exchange.country ?? "").toUpperCase()]);
  }

  write("server/data/ixpPrefixes.json", {
    _source: `PeeringDB exchange point prefixes, facilities and exchanges (https://www.peeringdb.com), fetched ${new Date().toISOString().slice(0, 10)}`,
    prefixes
  });

  const orgName = new Map(org.map((entry) => [entry.id, entry.name]));
  const networks: Record<string, string[]> = {};

  for (const network of net) {
    if (!network.asn) continue;

    const entry = [network.name ?? "", orgName.get(network.org_id ?? -1) ?? ""];

    if (network.aka) entry.push(network.aka.slice(0, 60));

    networks[String(network.asn)] = entry;
  }

  write("server/data/asOrgs.json", { _source: "PeeringDB networks and organisations (https://www.peeringdb.com)", networks });
  console.log(`peeringdb: ${byAsn.size} networks with facilities (${unmatched} rows in unplaced cities), ${prefixes.length} prefixes (${skipped} unplaced), ${Object.keys(networks).length} organisations`);
}

// ---------------------------------------------------------------------------------------
// Natural Earth roads and railroads, converted by mapshaper as build-land-graph.mts documents.
async function refreshLand() {
  const NE = "https://naciscdn.org/naturalearth/10m/cultural";
  const converted: string[] = [];

  for (const [name, filter] of [
    ["ne_10m_roads", ["-filter", 'type != "Ferry Route"']],
    ["ne_10m_railroads", []]
  ] as const) {
    await download(`${NE}/${name}.zip`, `${name}.zip`);
    execFileSync("unzip", ["-oq", path.join(cacheDir, `${name}.zip`), "-d", path.join(cacheDir, "ne")]);

    const out = path.join(cacheDir, `${name}.json`);

    execFileSync("npx", ["--yes", "mapshaper", path.join(cacheDir, "ne", `${name}.shp`), ...filter, "-simplify", "25%", "keep-shapes", "-o", "format=geojson", "precision=0.001", out], { stdio: "inherit" });
    converted.push(out);
  }

  execFileSync("npx", ["tsx", path.join(root, "scripts/build-land-graph.mts"), ...converted], { stdio: "inherit", cwd: root });
}

// ---------------------------------------------------------------------------------------
// Natural Earth countries at 1:50m, simplified to a quarter of their vertices: the globe's
// borders and coasts, and the router's land model. The 1:110m set drew Guangdong's coast
// thirty kilometres from the cables that hug it and had no Singapore at all.
async function refreshBorders() {
  const name = "ne_50m_admin_0_countries";

  await download(`https://naciscdn.org/naturalearth/50m/cultural/${name}.zip`, `${name}.zip`);
  execFileSync("unzip", ["-oq", path.join(cacheDir, `${name}.zip`), "-d", path.join(cacheDir, "ne")]);

  const out = path.join(cacheDir, `${name}.json`);

  execFileSync("npx", ["--yes", "mapshaper", path.join(cacheDir, "ne", `${name}.shp`), "-simplify", "25%", "keep-shapes", "-filter-fields", "NAME,ISO_A2,CONTINENT", "-o", "format=geojson", "precision=0.001", out], { stdio: "inherit" });

  type Feature = { properties: { NAME: string; ISO_A2: string; CONTINENT: string }; geometry: { type: string; coordinates: unknown } };
  // Consecutive duplicate vertices left by the rounding turned into degenerate rings, which
  // the globe's triangulation showed as holes.
  const cleanRing = (list: number[][]) => {
    const ring: number[][] = [];

    for (const [lng, lat] of list) {
      const point = [round(lng, 3), round(lat, 3)];
      const last = ring.at(-1);

      if (!last || last[0] !== point[0] || last[1] !== point[1]) ring.push(point);
    }

    if (ring[0][0] !== ring.at(-1)?.[0] || ring[0][1] !== ring.at(-1)?.[1]) ring.push(ring[0]);

    return ring;
  };
  const signedArea = (ring: number[][]) => ring.reduce((sum, [x, y], index) => sum + x * ring[(index + 1) % ring.length][1] - ring[(index + 1) % ring.length][0] * y, 0) / 2;
  // Outer rings clockwise and holes the other way, the way d3-geo reads a sphere: mapshaper
  // writes the opposite (RFC 7946), which d3 takes for the polygon's complement - the whole
  // globe - and the caps then took two minutes to triangulate instead of a third of a second.
  const wound = (ring: number[][], clockwise: boolean) => ((signedArea(ring) < 0) === clockwise ? ring : [...ring].reverse());
  const cleanPolygon = (rings: number[][][]) => rings.map((ring, index) => wound(cleanRing(ring), index === 0));
  const clean = (type: string, coordinates: unknown) => (type === "Polygon" ? cleanPolygon(coordinates as number[][][]) : (coordinates as number[][][][]).map(cleanPolygon));
  const collection = JSON.parse(readFileSync(out, "utf8")) as { features: Feature[] };

  write("public/data/countries.json", {
    _source: "Natural Earth 1:50m admin 0 countries, public domain (simplified to 25% with mapshaper, coordinates to 0.001 deg)",
    type: "FeatureCollection",
    features: collection.features.map((feature) => ({
      type: "Feature",
      properties: { name: feature.properties.NAME, iso: feature.properties.ISO_A2, continent: feature.properties.CONTINENT },
      geometry: { type: feature.geometry.type, coordinates: clean(feature.geometry.type, feature.geometry.coordinates) }
    }))
  });
}

if (wanted("cables")) await refreshCables();
if (wanted("peeringdb")) await refreshPeeringDb();
if (wanted("land")) await refreshLand();
if (wanted("borders")) await refreshBorders();
