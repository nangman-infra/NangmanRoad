# Nangman Road

Nangman Road is an install-free network route visualizer. Visitors enter a domain or IP address, choose Traceroute or MTR, and see the measured route on a live map with a terminal-style result view.

## Product Truth

A browser cannot run exact visitor-device `traceroute`, `mtr`, ICMP ping, raw sockets, or TTL-based probes.

Nangman Road therefore does not claim to trace directly from the visitor's PC. The honest model is:

1. The browser sends the target and UI context.
2. The backend validates the target.
3. The backend asks a distributed measurement provider, starting with Globalping, to measure from a nearby network probe.
4. The frontend visualizes the returned hops, locations, and terminal result.

Use this copy consistently:

- "Measured from a nearby network probe"
- "Install-free browser experience"
- "Not a direct trace from your device"
- "Exact device-level traceroute requires a local agent"

If exact visitor-device measurement is required later, this project needs a local agent, desktop app, or browser extension with a native helper.

## What It Does

- Traceroute mode for a route-style view.
- MTR mode for repeated monitoring-style measurements. Globalping's traceroute stops after 20 hops and its mtr after 30, and the API takes no option to raise either, so a target further off than that is never probed at all - the trace is right as far as it goes and simply stops short. When a traceroute spends its whole allowance without reaching the target the result says so and offers to measure again in mtr, which follows ten hops further; the offer is made whenever the allowance ran out, whether or not the last hops answered - a hop that returns nothing is a router that sent no reply of its own, and the target may still be several hops beyond it, unprobed - and nothing is re-measured until the visitor asks. A target whose routers all answered but which never answered itself, with hops to spare, is one whose network drops ICMP (most hosting networks do); the page then measures again over TCP to port 443, once and without asking, which the target's own listener answers - amazon.com is reached that way at hop 21 where ICMP stopped at 13 - and says so on the launch screen, the map note and the terminal; when fewer than ten searches' worth of the hour's Globalping allowance is left it asks first instead. The terminal line shows the flags that run carried (`traceroute -T -p 443`, `mtr -T -P 443`).
- Server-Sent Events for realtime measurement updates.
- Light and dark themes.
- A 3D globe, opened for every search, built once at page load (three.js) so the result never waits on it or stutters when it appears. The cable router runs in a Web Worker and routes each leg while the probe is still working, the final route is placed on the parked globe before the result is shown, and the animated page backdrop parks itself under a result - nothing heavy runs on the main thread when the map comes into view. It opens fixed over the probe, as far out as it goes, and the visitor turns it along the route. Twinkling city lights (Natural Earth places of 100,000+) and a star field wheel past as it turns, hop markers pulse, and the route is three screen-space lines in the colour of the leg's speed: a wide faint aura that stays solid, and over it the packets - the glow that is the body of the line and a thin white-hot core, both dashed, their dashes streaming from the probe to the far end every 2.6 seconds; the aura and the glow are blended additively so they light whatever is under them, the route, the hop rings, the names and the cables all sit at one height just clear of the land (0.003 of the globe's radius), separated only by two hundredths of a unit so that the pointer always picks the same one of them (a station's dot lies exactly on the line running through it, and with all three at one height the tooltip flickered between the place, the leg and - a ring carries none - nothing), because height is parallax: a point floating above the sphere is drawn away from the ground beneath it as soon as the globe is turned, and at the heights used before a coastal city's name slid a dozen pixels into the sea and the route left its own cable behind; every layer is drawn as a dashed line because dashed fat lines have no round end caps (the caps of neighbouring segments overlapped at every vertex and added up into a bright bead), and all of them are drawn after the land caps, so the route never dips under a continent. The packets tell land from sea at a glance: overland they run as fine, close dots, at sea as long dashes, the same sizes on every stretch whatever its length (three-globe measures dashes as a share of the line, so each stretch gets its own ratio), and each pattern moves one step a second or so, a stream rather than a strobe. By day nothing can glow (light on white is white), so each dash is the speed's own colour at full strength on a dark rim with a white core, over a pale halo that alone shows between dashes: sharp on the pale map, with the stream still readable (pastel tints and muted day palettes both read as a dark or dead line beside the cables); the cables stay faint context, and the credits box turns light with the map. A target that never answered is named beside the last router that did, marked "no answer" on both maps, and nothing is drawn to a place nobody measured. The two ends are always named; every hop placed in a city is named where its name does not land on another, and the landing stations an inferred chain touches are named smaller and fainter - every station it runs through, not only the two at the ends of a sea run, since a chain hands from one cable system to the next at a station shared by both and those handovers fall in the middle: across twelve legs from every ocean that is 52 stations with a name to write where reading only the ends gave 28 (Matara on the way round Sri Lanka, Fortaleza on the South Atlantic, Zafarana and Abu Talat either side of Suez).  A name goes below its dot, or above it, or to its right, whichever keeps it off the names already placed, so a target answering from the probe's own city (an anycast address) takes the side the probe's name does not instead of printing over it. A name that fits nowhere gets one more chance before it is dropped: each name already in its way is offered its other sides, and the first move that clears both is taken, which is how a target and the hop a degree below it both keep their names instead of the first one placed hanging across the second. Names are folded to what the globe's typeface can draw before they are written - it carries ASCII and Greek only, and three.js quietly substitutes a question mark for anything else, which drew Belém as "Bel?m" - so accents that decompose are stripped and letters that do not are spelled out, while the hover text keeps the name in full. The two ends are marked apart from the hops between them: on the globe by a mark half again as wide in the page's own black and white with a glow drawn around it, a cold bloom close in and a faint warm rim further out, because the globe's ring layer draws hairlines and no number of hairlines makes a glow; on the flat map by colour, blue for the probe and violet for the target, neither of them a colour the speed scale can produce. Names and their dots are written in degrees of the globe, so they are scaled down as the camera comes in - by the share of the world still in view - which keeps every name the same size to read and shrinks what it covers of the map, so the names that had nowhere to go at arm's length appear as the view closes in: a route across the Atlantic shows four landing stations from orbit and seven up close. The set is picked again only once the view has come to rest, since laying out a name builds its glyphs and doing that on every turn of the wheel would cost frames. Last and faintest come the cities a sea stretch passes off - half a million people or more, within 60 km of the line, one every 350 km, never on a hop or a station - read from the map alone, and their hover says so: nothing claims the packet touched that city's network. Hovering a stretch says what it is, why, and how fast the packet crossed the hop leg it belongs to, in the legend's words; the line objects are handed the canvas size as their resolution every frame, since three-globe gives them the window's, which drew them thinner than set and let the pointer find them only within a pixel or two. A leg whose speed cannot be measured (no growth in round-trip time between its hops) stays the legend's grey instead of being pulled to white. The globe renders at no more than 1.5 device pixels per CSS pixel, keeps a hidden stand-in of every layer alive so its shaders are compiled once and never again (disposing a route's materials used to free them, and the next frame compiled them all over, a stall on every hop), draws nothing while it is out of sight - parked before a result, or behind the flat map, where it stays mounted so switching views costs no rebuild - tessellates land caps at 1.5° so they never sink into the sphere, and the result appears with a plain fade, no blur filter over the canvas. Submarine cables are one screen-width line set, resampled onto the sphere along the source's own straight runs, drawn above the land polygons, joined where the source leaves a branch short of its trunk or a station's two lines apart, and left out where a line would only ever be seen ending in open water or is shorter than 40 km; joins run only between lines that stay, settled in rounds, so no stray join survives a dropped line. Antarctica keeps its coastline but no cap, since its pole-wrapping ring cannot be triangulated flat.
- Route map with confidence-scored hop locations.
- Terminal result view for raw-ish trace/MTR output.
- The page in English or Korean: a toggle beside the theme switch, remembered in the browser, chosen at first by the browser's language. The terminal's output and the data credits stay in English, one being a command's output and the other a licence's wording. The router reports the evidence behind a verdict as codes, so the tooltips word it in either language.
- A "Measure again from" control in the result header re-runs the same target from another probe without going back to the search.
- On a phone the route details fold away under a button, so the map is not half covered.
- Two small cards in the corner beside the language toggle: a contact address (with a copy button) and a link to the team's site, nangman.cloud.
- An offline demo provider (`MEASUREMENT_PROVIDER=demo`) for development and the browser test. It is never a fallback: a failed measurement says so instead of drawing invented hops.

## Measurement Notes

### Traceroute

Traceroute mode takes the provider's traceroute result and visualizes reliable location points on the map.

### MTR

MTR is displayed as:

```bash
mtr -rwc 16 -z <target>
```

`-c 16` means 16 probe cycles, not 16 hops. The Globalping MTR API currently caps packet samples at 16, so the UI and terminal copy use 16 instead of pretending to run a local 30-cycle MTR.

Local `mtr -rwc 30 -z <target>` can differ because it runs from your own machine and sends more cycles. Exact local parity requires a local agent.

## Route Geolocation

The map does not blindly place every hop. Each hop's city is chosen from several independent pieces of evidence, and the route as a whole has to be physically possible:

- **Three IP geolocation databases** (ip-api, ipwho.is, IP2Location.io) are queried in parallel. When two agree within 120 km that answer wins with high confidence; the outvoted answer is kept as a fallback candidate instead of being discarded.
- **Operator site labels**: Cogent, Microsoft and EdgeUno write the site's own airport code in a fixed label of every router name (`…mia03.atlas.cogentco.com`, `…cph30.ntwk.msn.net`, `…cwb1.as7195.net`). Read from that position the code needs no database to confirm it, because the position is the operator's convention - which is also what keeps the router role in the same name (`ccr41`, `owr02`) from being read as a city. Curated city names win first, so a hub keeps the name a reader expects.
- **Reverse DNS**: city names, IATA airport codes and verified carrier site codes in router hostnames (`cr5-lax2`, `dllstx14`, `eqxty2`, `us-mia01a`), checked against a 4,429-entry airport table and the operator codes in `bench/truth.json`. An airport code is accepted only when a database, or the name's own country prefix (`us-`, `de-`), already puts the hop in that country - three-letter tokens collide constantly. A name beats a database that disagrees by more than a metro: for backbone blocks the database usually holds the operator's registration address, not the router (Liberty Global registers everything in the Netherlands; `us-mia01a` is in Miami).
- **Speed-of-light check**: two hops on the same path can only be as far apart as light in fibre covers in the latency between them. A hop's latency is read as the smallest RTT seen from that hop onward, which strips the padding a slow router adds to its own reply. A placement that would need the packet to outrun light (100 km per ms of RTT gain, plus 3,000 km of slack for reply padding) is dropped. This check is blind below continental scale by design: it settles which continent a hop is on, never which city inside one.
- **Relocation**: a dropped hop is retried against the next candidate the databases offered, after the rest of the route is consistent. A candidate that fits is used and marked as a second choice; otherwise the hop stays blank.
- **Named hops are never dropped by the latency check.** Inside an MPLS tunnel every hop answers with the egress router's RTT, which makes a real Miami look unreachable from Frankfurt; a site code the operator wrote into the router's name outranks that argument, so the hop stays and is left out of it.
- `AS0` (reserved, RFC 7607) from a database means "no ASN" and never appears in the AS path.
- **Research and education networks**: the national backbones that carry university traffic name their routers after their own points of presence, and that name is the operator's own statement of where the router stands. Thirteen networks are read this way - Jisc in the UK (`londtt`, `mancrh`), RNP in Brazil (`cpr1` is Curitiba, `csp2` São Paulo, from the state codes), GÉANT across Europe (`mx1.lon2.uk`), DFN in Germany, GARR in Italy, CANARIE in Canada, TENET in South Africa, SWITCH, BelWue, NORDUnet, IX.br, IX New Zealand - covering some 120 sites. A code counts only inside its own network's domain, so a two or three letter site code can never leak into another operator's names, and the earliest code in a name wins, because a router is named for its own site before the far end of the link it carries. Where a network writes the site in a fixed position instead, that position is read: GARR's `rs1-mi01-rl1-bo01.bo01.garr.net` is a Bologna router whatever the link is called. Every code comes from a traceroute captured for this project or from [CAIDA's published router naming conventions](https://publicdata.caida.org/datasets/supplement/2019-imc-hoiho/); none is guessed, and `server/geoInference.test.ts` pins each one to a real router name. Before this, those hops fell to a single geolocation database: one RNP router the databases put in Rio de Janeiro is named as São Paulo's, 360 km away, and another they put in a Rio suburb is Curitiba's, 680 km away.
- **Metro fill**: a hop with no usable candidate that answers within 5 ms of a corroborated neighbour inherits that neighbour's metro area, labelled as an area rather than a city - and only if the probe's own distance allows it, since a router answering the probe in a millisecond is not in the next city however close in latency its neighbour is.
- A lone weak database point sitting between two reliable hops in the same metro is suppressed.

Every decision is recorded per hop and shown in the map tooltip and the traceroute terminal view, so a blank on the map always comes with its reason.

Unknown or low-confidence hops stay in the terminal output instead of being forced onto the map. If no hop answered from the target's address, the last router that answered is drawn as an ordinary hop - the target's name is never pinned to a router that merely came last - and the note under the map says whether the trace ran out of hops (traceroute follows 20, MTR 30) or the target stopped answering. Public IP geolocation is often approximate: a backbone router registered in Madrid may be answering from Sao Paulo, and a lone database answer says nothing about which. Nangman Road prefers a blank with a reason over a confident wrong pin.

## Map data and credits

- Basemap tiles: © OpenStreetMap contributors, © CARTO.
- Router naming conventions for the research networks: read from traceroutes captured for this project, and cross-checked against [CAIDA's HOIHO dataset](https://publicdata.caida.org/datasets/supplement/2019-imc-hoiho/), published for research use.
- Submarine cables (`public/data/cables.json`) and landing stations (`public/data/landings.json`): © TeleGeography, [Submarine Cable Map](https://www.submarinecablemap.com), licensed [CC BY-SA 4.0](https://creativecommons.org/licenses/by-sa/4.0/). The bundled copy is simplified (coordinates rounded to 0.01°, vertices closer than 0.15° dropped) and stays under the same licence; the 101 systems the map lists as planned or not yet in service are left out, so no route rides a cable that does not exist yet. Landing stations name the router's stations and the stretches that come ashore at them. Cables are drawn as context under the route; the route's sea legs follow them only as a labelled inference, and the hops are the only measured points.
- Country outlines (`public/data/countries.json`): Natural Earth 1:50m, public domain, simplified to a quarter of its vertices with mapshaper (about 27,000 remain), coordinates kept to 0.001° with consecutive duplicate vertices removed and outer rings wound clockwise (coarser rounding left degenerate rings that the globe's polygon triangulation turned into holes, and rings wound the RFC 7946 way are read by d3-geo as the rest of the sphere, which made the caps take two minutes to triangulate; the caps themselves are tessellated at 1.5°, since at the default 5° a triangle across Siberia sagged below the sphere and the dark globe showed through). The 1:110m set used before drew Guangdong's coast thirty kilometres from the cables that hug it, so a sea stretch ran over the land, and had no Singapore at all. They draw the borders on the globe and give the cable router its land model: which piece of land a hop or a landing station stands on, and its country and continent. From that the router decides land or sea by the evidence it actually has. Terrestrial fibre never leaves a piece of land and never crosses a border that carries none, so a leg off its landmass, or across South Korea's border (North Korea's is the only one), the Darién Gap, or Israel's borders with Lebanon and Syria, is a cable. On one piece of land a domestic leg is terrestrial, and so is an international one whose straight line never crosses more than 60 km of open water at a stretch - what a bridge or a tunnel spans. One that does (Seoul to Hong Kong, Helsinki to Tallinn, Paris to London) is a cable when a chain exists that is no more than 1.6 times the straight line, fits the growth in round-trip time between the two hops (about 102 km per millisecond in fibre, with a margin), covers the water the straight line crosses and does not walk farther overland than the straight line is long; failing that it is terrestrial after all. Where a station sits on a small island the coarse coastline leaves out (Kinmen), its country comes from its name; cables that only join two countries across a border with no transit (Kinmen to Xiamen) are open to legs between those two countries and closed to all others, and a chain that walks into a neighbour's station pays for it, so a packet for Hong Kong lands in Hong Kong. A routed leg is cut wherever it leaves the sea for the land or the other way round, and every stretch says what it is: which cable systems it rides and between which landing stations, or that it is overland from a named landing to the hop. A cable's own line crosses land in places - Egypt between the Mediterranean and the Red Sea, the Kra isthmus, a station some way inland - so every sea run is also cut wherever its line stays on land for 20 km or more (sampled every 5 km against the coastline), and that part is drawn as land under the cable's name; anything shorter is the coastline's own fuzz and stays sea. Overland stretches and land legs are drawn along `public/data/land.json`, Natural Earth's 1:10m roads and railroads snapped to a 0.3° grid so crossings join, with every 100,000+ place and landing station tied to the nearest road and a sparse grid of waypoints where no road comes (built by `scripts/build-land-graph.mts`) - fibre runs where roads and rails run, so a path through it stays on land and follows the coast where a straight line would cross the sea - and their tooltip still says the real route is not public data. Between two stations a chain walks at three times the price of the sea, so a packet on a system that runs on by sea stays on it instead of coming ashore and walking to the next station (the cheapest chain used to leave EAC-C2C at Taipei, cross Taiwan by road and board it again), while a real crossing between systems (Egypt, the Kra isthmus) still wins over going round a continent; and where land could carry the leg, a chain may walk at most half the straight line, so a walk with a few kilometres of cable in it (Cairo to Tel Aviv over Sinai) stays a walk. A carrier rides the cables it owns: the networks at a leg's two ends, as the traceroute names them, are matched against TeleGeography's owner lists, and a chain on one of their own cables costs less in the search than a stranger's, so a KT hop bound for Hong Kong takes APG. Every stretch's tooltip ends with the evidence behind the verdict - the landmass, the border, the water the straight line crosses, the owner, the latency it fits. Every hop's round-trip time is the smallest of its tries (queueing only adds), and the probe's own position, at zero latency, anchors the physics check that drops a hop placed farther away than its round trip allows - the last hop of all included, which is how an anycast address answered from a nearer site is caught. `src/lib/cableRouting.decisions.test.ts` pins the land-or-cable verdict for thirty city pairs across every continent, so a rule change shows exactly which pairs it turned. Hop placement reads more of the router's name (some ninety city spellings and the fixed site-code patterns of NTT and Arelion) and checks each candidate city against the network's own facility list from PeeringDB (`server/data/peeringdbCities.json`, 14,000 networks, built at deploy time and kept out of the repository under PeeringDB's acceptable use policy): a city the network has a documented point of presence in is backed up, and a network with several documented sites and none anywhere near the candidate loses it.
- City lights on the globe (`public/data/cities.json`): Natural Earth 1:10m populated places with 100,000 people or more (about 3,100), public domain, with their names, which the globe uses to say which city a sea stretch passes off.
- `npm run data:refresh` rebuilds the cable, landing station, PeeringDB, road-corridor and country outline files from their sources (`scripts/refresh-data.mts`; one of `cables`, `peeringdb`, `land`, `borders` as an argument runs that step alone, `--fresh` downloads again instead of reusing `.cache/data-refresh`). The city list is kept by hand, as it changes once in years. The bundled files are exactly what the script writes from the snapshot it was last run on.
- The 3D view is a separate JavaScript chunk (three.js via globe.gl, about 540 kB gzipped) that loads only when the 3D toggle is used, so the 2D map keeps its normal size.

## Measured accuracy

`bench/` feeds the same raw traceroutes (30 routes across every continent, captured from Globalping probes and committed as fixtures, six of them to universities so the research backbones are covered) through the geolocation pipeline and scores the result two ways that need no ground truth:

| Metric | Nangman Road | geotraceroute.com, same input |
| --- | --- | --- |
| Routes implying faster-than-light travel | **0 / 12** | 2 / 11 |
| Agreement with the operator's own router naming (55 named hops) | **55 correct** | 54 correct, 1 wrong |
| Hops placed, of those that answered | 148 / 150 | - (city list, not per hop) |

The first metric is the hard one: a route's path length divided by half its final RTT cannot exceed the speed of light in fibre (about 204,000 km/s), whatever the databases say. The second uses the site codes backbone operators put in reverse DNS (`dllstx` = Dallas, `eqxty2` = Equinix TY2, Tokyo) as near-ground-truth; `bench/truth.json` lists the 26 codes used.

Reproduce our column with `npx tsx bench/score.mts`. The geotraceroute column was obtained by pasting the same fixture files into that site's "own traceroute" form on 2026-09-05 and is recorded, not re-run, by the script. The fixture set has since grown to 30 traces from every continent (`bench/collect.mjs` refreshes it); on that set, on 2026-09-07, the pipeline implied faster-than-light travel on 0 of 29 scored routes, agreed with all 105 operator-named hops, and placed 336 of 359 hops that answered. Of the router names in a wider sweep of 416 collected from research and commercial backbones, 224 are placed by the name alone, with no geolocation database consulted. The placement count swings with the free GeoIP providers' quotas (216 on a throttled run), so `bench/geo-cache.json` keeps complete answers between runs and a rule change is compared on one provider state.

## Stack

- React + TypeScript + Vite
- Tailwind CSS
- Framer Motion
- Leaflet
- Express
- Server-Sent Events
- Globalping API

## Local Setup

```bash
npm install
cp .env.example .env
npm run dev
```

GeoIP is on by default using the free ip-api endpoint:

```bash
GEOIP_PROVIDER=ip-api
IP_API_URL=http://ip-api.com
IP_API_KEY=
```

The free endpoint is HTTP-only, allows 45 requests per minute per source IP, and is
non-commercial. The backend calls it server-side, so browser mixed-content rules do not
apply. It reports `X-Rl` and `X-Ttl`; the server honors them and pauses lookups when the
budget runs out, because repeatedly exceeding the limit gets the source IP banned for an
hour. One measurement can spend 20-30 lookups, so a busy public deployment will hit the
budget. Switch to ip-api Pro for HTTPS, unlimited requests, and commercial use:

```bash
IP_API_URL=https://pro.ip-api.com
IP_API_KEY=your-ip-api-pro-key
```

Do not commit `.env` or provider keys.

The dev script starts:

- Frontend: `http://127.0.0.1:5173`
- Backend: `http://127.0.0.1:8787`

Health check:

```bash
curl http://127.0.0.1:8787/api/health
```

Build check:

```bash
npm run check
npm run build
```

## Quality Checks

Current scripts:

```bash
npm run check   # TypeScript typecheck
npm test        # Vitest unit tests with coverage
npm run build   # TypeScript typecheck + Vite web build + Express server bundle
npm run start   # Run the production server from dist-server/index.js
npm run test:e2e   # Playwright: builds the app, serves it in demo mode on port 8790 and walks through a search in the installed Chrome
npm run data:refresh   # Rebuild the bundled cable, landing, PeeringDB and corridor data from their sources
```

Not configured yet:

- `lint`: no ESLint or Biome config is present.
- `format`: no Prettier or Biome config is present.

Before a production release, add linting/formatting and keep the focused test suite for target validation, provider parsing, and route geolocation inference passing.

## Docker

Build the production image:

```bash
docker build -t nangman-road .
```

Run it locally:

```bash
docker run --rm -p 8787:8787 --env-file .env nangman-road
```

The container serves both:

- frontend app from `dist/`
- backend API from `/api/*`

Health check:

```bash
curl http://127.0.0.1:8787/api/health
```

## CI/CD

This repository includes a `Jenkinsfile` for the existing Nangman infrastructure pipeline.

Before enabling the Jenkins job, confirm these values in `Jenkinsfile`:

- `REPO_SLUG`
- `DEFAULT_REPO_HTTP_URL`
- `IMAGE_NAME`
- `APP_HEALTH_URL`
- external port mapping in the on-prem Docker/Watchtower host
- SonarQube project key and Quality Gate policy
- nothing for PeeringDB: the `Fetch PeeringDB` stage builds the PeeringDB-derived files on the agent, and when PeeringDB refuses (anonymous callers get 20 requests a minute and one repeat of a large request an hour) it reuses the files from the image in production, using the Harbor credential the pipeline already has. A `PEERINGDB_API_KEY` in the agent's environment, if one is ever provided, raises the limit to 40 a minute; it is not required

## Environment

Copy `.env.example` to `.env` when you need local configuration.

```bash
PORT=8787
GLOBALPING_API_URL=https://api.globalping.io/v1/measurements
GLOBALPING_TOKEN=
MEASUREMENT_PROVIDER=globalping
GEOIP_PROVIDER=ip-api
IP_API_URL=https://pro.ip-api.com
IP_API_KEY=
IPINFO_TOKEN=
IP2LOCATION_API_KEY=
GEOIP_SECONDARY=
RIPE_IPMAP=
GEOIP_TIMEOUT_MS=1400
REVERSE_DNS_TIMEOUT_MS=900
```

Provider options:

- `MEASUREMENT_PROVIDER=globalping`: measure through Globalping. A failed measurement is
  reported as an error; it never falls back to demo data, because a route the visitor cannot
  tell from a real one is worse than no answer.
- `MEASUREMENT_PROVIDER=demo`: use demo data only. Offline development mode — the hops are
  invented from RFC 5737 documentation addresses, so never point a public deployment at it.
- `GLOBALPING_TOKEN`: optional, but useful for authenticated/provider-limited usage.

Measurement options:

- `GLOBALPING_PROBE_CANDIDATES=3`: probes asked per measurement. They run in parallel and the path that answered on the most routers is the one drawn - a cloud probe often rides a private backbone that shows nothing between continents, while a home-ISP probe in the same city crosses the public internet router by router. Set to `1` to always take the first probe. Where the probe picker lists one city for a country, the whole country is the pool and the result names the city it actually ran from. Unauthenticated Globalping allows 250 probe runs per hour per server address, so three candidates means about 80 measurements an hour for the whole site. Every measurement asks the same number of probes regardless of how much budget is left - a thinner result is not traded for a fuller budget - and once the hour's budget is gone, visitors are told when it resets. A free Globalping account (`GLOBALPING_TOKEN`) doubles the budget to 500, and hosting a probe adds 150 runs a day per probe - a probe on a home connection also puts a public-internet vantage point into the pool.

GeoIP options:

- `GEOIP_CACHE_TTL_MS=86400000` / `GEOIP_PARTIAL_CACHE_MS=3600000`: a database's answer for an IP is kept for a day - backbone routers do not move, and the same ones appear on the way to most destinations, which is what keeps the daily database budgets intact. An answer with a source missing (quota spent, timeout) is used but re-asked after an hour, so a bad hour never decides a hop's evidence for the next twenty-four.
- `GEOIP_PROVIDER=ip-api`: use ip-api for hop city/ASN enrichment.
- `IP_API_URL=https://pro.ip-api.com`: HTTPS ip-api Pro endpoint for production.
- `IP_API_KEY`: ip-api Pro key. Keep this in local `.env`, Jenkins credentials, or server environment only.
- `GEOIP_PROVIDER=ipinfo`: requires `IPINFO_TOKEN`.
- `GEOIP_PROVIDER=none`: disables external IP geolocation.
- `GEOIP_SECONDARY=none`: skips the second database (ipwho.is); `IP2LOCATION_API_KEY` adds the third (IP2Location.io, which asks for the credit line the map shows).
- `RIPE_IPMAP=off`: skips RIPE IPmap, the fourth source, which answers for a minority of backbone addresses with a measured or geofeed-backed city; its silence is normal and never counts as a missing answer.
- `GEO_CACHE_FILE`: a JSON file of complete GeoIP answers kept on disk (the bench sets it to `bench/geo-cache.json`); unset in production.
- `PEERINGDB_DATA_DIR`: where the PeeringDB-derived files are read from at startup (default `server/data`); `PEERINGDB_API_KEY` is sent when `npm run data:refresh -- peeringdb` builds them.
- `SITE_CODE_CANDIDATES_FILE`: where the server writes router-name tokens no code table knows, next to the city the other evidence settled on (default `state/site-code-candidates.jsonl`; `off` stops it). The budget report lists them for whoever keeps the code table; the placement never reads them back, because a code learnt from the databases would only repeat their answer under a stronger label. In the container this is `/app/state` on the `nangman-road-state` volume, so the list survives image swaps.

For production, use a licensed HTTPS GeoIP source such as ip-api Pro. Do not commit provider keys to Git.

## API

### `GET /api/health`

Returns backend status.

### `POST /api/measurements`

```json
{
  "target": "example.com",
  "mode": "traceroute"
}
```

`mode` can be:

- `traceroute`
- `mtr`

### `GET /api/measurements/:id/events`

Streams Server-Sent Events:

- `measurement_started`
- `hop_result`
- `metric_update`
- `measurement_finished`
- `error`

## Security Rules

- Never pass user input directly into shell commands.
- Validate targets as domains or IP addresses.
- Reject spaces, shell operators, redirects, pipes, semicolons, and unusual characters.
- Keep provider API keys on the backend only.
- Apply rate limits, timeouts, and cancellation.
- Do not expose raw provider errors or server internals to users.
- Nothing secret is in the repository: `.env` is ignored, every provider key comes from the environment, and the one key in `Dockerfile` (`VITE_CARTO_API_KEY`) is a public client-side basemap key that ships in the browser bundle either way - restrict it to the site's origin in the CARTO console rather than treating it as a secret.
- The PeeringDB-derived files are built at deploy time and never committed (see the licence notes); the bench's GeoIP cache and the Serena tool state are ignored too.
- Data files under `/data` are served with a day's cache and a per-build version in their URL, so a rebuilt page never reads the previous build's data.

## GitHub Publishing Checklist

Committed:

- `src/`, `server/`, `shared/`, `scripts/`, `e2e/`, `bench/` (raw traceroute fixtures and the scorer)
- `public/data/` - the map data: TeleGeography-derived cables and landings (CC BY-SA 4.0), Natural Earth countries, cities and road corridors (public domain)
- `README.md`, `AGENTS.md`, `LICENSE`, `Dockerfile`, `Jenkinsfile`, `.dockerignore`, `.env.example`
- `package.json`, `package-lock.json`, `vite.config.ts`, `vitest.config.ts`, `playwright.config.ts`, `tailwind.config.ts`, `tsconfig.json`, `postcss.config.js`

Not committed (all in `.gitignore`):

- `.env` or any real API token
- `server/data/*.json` - the PeeringDB-derived files, built at deploy time (`npm run data:refresh -- peeringdb`)
- `bench/geo-cache.json`, `.cache/`, `node_modules/`, `dist/`, `dist-server/`, `coverage/`, `playwright-report/`, `test-results/`, logs, screenshots, `.DS_Store`
- future measurement databases containing user-entered domains, IPs, or visitor metadata

## License And Attribution

The source is released under the Apache License 2.0 (`LICENSE`), with the attribution this work requires in `NOTICE`:

```
Copyright (c) 2026 낭만 인프라. All rights reserved.
```

Section 4(d) of that licence obliges anyone who redistributes this software, or a work derived from it, to carry the contents of `NOTICE` with their distribution - in a NOTICE file, in the source or documentation, or on screen wherever third-party notices normally appear. Apache 2.0 was chosen over MIT for that clause and for its explicit patent grant; MIT asks only that the licence text travel inside copies of the source, which a hosted product need never show anyone. The line is also printed at the foot of the map. It claims nothing over the data below, which comes with terms of its own:

| What | Terms | How it is honoured |
| --- | --- | --- |
| Submarine cables and landing stations (`public/data/cables.json`, `landings.json`) | © TeleGeography, [Submarine Cable Map](https://www.submarinecablemap.com), CC BY-SA 4.0 | Credited on both maps and here; the simplified copies stay under CC BY-SA 4.0 |
| Countries, cities, roads and railroads (`public/data/countries.json`, `cities.json`, `land.json`) | Natural Earth, public domain | Credited on the globe |
| Facilities, exchange prefixes and organisations (`server/data/*.json`) | [PeeringDB acceptable use policy](https://www.peeringdb.com/aup): usable for network troubleshooting, not for commercial use or passing on in bulk | Used only to place routers; built at deploy time and never committed or served to visitors |
| RIPE IPmap | [RIPE NCC terms of service](https://www.ripe.net/about-us/legal/ripe-ncc-terms-of-service/); the API is public | Queried per address at measurement time; nothing stored beyond the day's cache |
| ip-api (free endpoint) | Non-commercial use, 45 requests a minute | Rate limits honoured; use ip-api Pro for a commercial or busy deployment |
| ipwho.is, IP2Location.io | Free tiers with quotas; IP2Location.io asks for a credit | Quotas honoured; the credit line is shown on the globe |
| Globalping | [Globalping terms](https://globalping.io); 250 probe runs an hour without a token | The hourly budget is counted and visitors are told when it resets; tokens never committed |
| Basemap tiles | © OpenStreetMap contributors, © CARTO | Attribution kept on the flat map |
| npm dependencies | Permissive licences (MIT, ISC, Apache-2.0, BSD); mapshaper (MPL-2.0) runs only through `npx` when data is refreshed | See `package-lock.json` before a formal release |

## Example Targets

- `google.com`
- `cloudflare.com`
- `1.1.1.1`
- `overclockers.com.au`
