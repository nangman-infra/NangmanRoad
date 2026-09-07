// Refreshes bench/traces from Globalping. The fixtures are committed, so this only needs
// running when the probe set or the routes themselves should be re-sampled.
import { writeFileSync } from "node:fs";

const PAIRS = [
  ["Seoul", "KR", "overclockers.com.au"], ["Seoul", "KR", "www.ufpr.br"],
  ["Frankfurt", "DE", "www.ufpr.br"], ["New York", "US", "overclockers.com.au"],
  ["London", "GB", "www.iij.ad.jp"], ["Sao Paulo", "BR", "www.telstra.com.au"],
  ["Sydney", "AU", "www.uct.ac.za"], ["Singapore", "SG", "www.ucalgary.ca"],
  ["Los Angeles", "US", "www.sanger.ac.uk"], ["Tokyo", "JP", "www.uct.ac.za"],
  ["Mumbai", "IN", "www.ufpr.br"], ["Amsterdam", "NL", "overclockers.com.au"],
  // Every continent as a starting point, so the land-or-cable rules and the city codes are
  // checked where the data is thinnest, not only where it is best.
  ["Johannesburg", "ZA", "www.ufpr.br"], ["Nairobi", "KE", "www.iij.ad.jp"], ["Lagos", "NG", "www.ucalgary.ca"],
  ["Buenos Aires", "AR", "www.sanger.ac.uk"], ["Santiago", "CL", "www.iij.ad.jp"], ["Mexico City", "MX", "www.iij.ad.jp"],
  ["Dubai", "AE", "overclockers.com.au"], ["Tel Aviv", "IL", "www.ufpr.br"], ["Istanbul", "TR", "www.telstra.com.au"],
  ["Auckland", "NZ", "www.uct.ac.za"], ["Bangkok", "TH", "www.sanger.ac.uk"], ["Jakarta", "ID", "www.ucalgary.ca"]
];
const only = process.argv.slice(2);
const chosen = only.length > 0 ? PAIRS.filter(([city]) => only.includes(city)) : PAIRS;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

for (const [city, country, target] of chosen) {
  const slug = `${city.replace(/\s+/g, "")}-${target}`.replace(/[^\w.-]/g, "_");
  const post = await fetch("https://api.globalping.io/v1/measurements", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      type: "traceroute", target, locations: [{ city, country }], limit: 1,
      measurementOptions: { protocol: "ICMP" }
    })
  });

  if (!post.ok) { console.log(`${slug}: HTTP ${post.status}`); continue; }
  const { id } = await post.json();

  let data;
  for (let attempt = 0; attempt < 15; attempt += 1) {
    await sleep(3000);
    data = await (await fetch(`https://api.globalping.io/v1/measurements/${id}`)).json();
    if (data.status === "finished") break;
  }

  const result = data?.results?.[0];
  if (!result?.result?.rawOutput) { console.log(`${slug}: no output`); continue; }

  writeFileSync(
    new URL(`traces/${slug}.json`, import.meta.url),
    JSON.stringify({ city, country, target, probe: result.probe, raw: result.result.rawOutput }, null, 2)
  );
  console.log(`${slug}: ok`);
}
