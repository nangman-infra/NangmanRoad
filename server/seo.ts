import { readFile } from "node:fs/promises";
import type { Request, Response } from "express";

const siteName = "Nangman Road";
const pageTitle = "Nangman Road | Install-free Network Route Visualizer";
const pageDescription =
  "Visualize Traceroute and MTR-style network routes from nearby distributed probes with an install-free browser experience.";
// A raster, and not the SVG that stood here: no link-preview scraper - Slack, KakaoTalk,
// X, Facebook, Discord - renders an SVG, so the card came up blank wherever the site was
// shared. JPEG over PNG because the picture is all soft gradient, which costs 750 KB
// lossless and 76 KB here.
const imagePath = "/og-image.jpg";
// Built here rather than inside the tag below: a template literal nested in another
// reads as one expression and is two.
const imageAlt = `${siteName} - ${pageDescription}`;

let cachedIndexHtml: Promise<string> | undefined;

function escapeHtml(value: string) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll("\"", "&quot;");
}

function escapeXml(value: string) {
  return escapeHtml(value).replaceAll("'", "&apos;");
}

function trimTrailingSlash(value: string) {
  let endIndex = value.length;

  while (endIndex > 0 && value[endIndex - 1] === "/") {
    endIndex -= 1;
  }

  return value.slice(0, endIndex);
}

function configuredSiteUrl() {
  const configured = process.env.PUBLIC_SITE_URL?.trim();

  if (!configured) {
    return undefined;
  }

  try {
    const url = new URL(configured);
    return trimTrailingSlash(url.origin + url.pathname);
  } catch {
    return undefined;
  }
}

// Where the site answers, for a deployment that does not name it. The container runs behind
// a proxy that keeps the original host to itself, so the request carries the private address
// it was forwarded to - http://172.16.0.37:8787 - and the page was handing that to scrapers
// and search engines as the place to fetch its picture from. Nothing outside the house can
// reach it, which is why the link preview came up empty. PUBLIC_SITE_URL still wins.
const defaultSiteUrl = "https://road.nangman.cloud";

// A site the public reaches is reached by name. A bare address in the host means the proxy
// forwarded to one, never the name the visitor typed, so it is not the address to publish.
function isBareAddress(host: string) {
  return /^(\d{1,3}\.){3}\d{1,3}(:\d+)?$/.test(host) || host.startsWith("[");
}

function requestSiteUrl(req: Request) {
  const host = req.get("host");

  if (!host) {
    return `http://127.0.0.1:${process.env.PORT ?? 8787}`;
  }

  return isBareAddress(host) ? defaultSiteUrl : `${req.protocol}://${host}`;
}

export function siteUrlForRequest(req: Request) {
  return configuredSiteUrl() ?? requestSiteUrl(req);
}

function structuredData(siteUrl: string, imageUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: siteName,
    url: `${siteUrl}/`,
    image: imageUrl,
    applicationCategory: "NetworkingApplication",
    operatingSystem: "Any",
    description: pageDescription,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD"
    },
    featureList: [
      "Traceroute-style route visualization",
      "MTR-style network measurement display",
      "Measured from nearby distributed network probes",
      "Install-free browser experience"
    ]
  };
}

function dynamicHead(req: Request, res: Response) {
  const siteUrl = siteUrlForRequest(req);
  const canonicalUrl = `${siteUrl}/`;
  const imageUrl = `${siteUrl}${imagePath}`;
  const nonce = typeof res.locals.cspNonce === "string" ? res.locals.cspNonce : undefined;
  const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";

  return [
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`,
    `<meta property="og:image:type" content="image/jpeg" />`,
    `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`,
    `<script type="application/ld+json"${nonceAttribute}>${JSON.stringify(structuredData(siteUrl, imageUrl))}</script>`
  ].join("\n    ");
}

function insertDynamicHead(html: string, head: string) {
  const marker = "</head>";
  const markerIndex = html.indexOf(marker);

  if (markerIndex === -1) {
    return html;
  }

  return `${html.slice(0, markerIndex)}    ${head}\n  ${html.slice(markerIndex)}`;
}

export async function sendIndexHtml(req: Request, res: Response, indexPath: string) {
  cachedIndexHtml ??= readFile(indexPath, "utf8");
  const html = await cachedIndexHtml;

  res.type("html").send(insertDynamicHead(html, dynamicHead(req, res)));
}

export function sendRobotsTxt(req: Request, res: Response) {
  const siteUrl = siteUrlForRequest(req);

  res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);
}

export function sendSitemapXml(req: Request, res: Response) {
  const siteUrl = siteUrlForRequest(req);
  const homeUrl = `${siteUrl}/`;
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">',
    "  <url>",
    `    <loc>${escapeXml(homeUrl)}</loc>`,
    "    <changefreq>weekly</changefreq>",
    "    <priority>1.0</priority>",
    "  </url>",
    "</urlset>"
  ].join("\n");

  res.type("application/xml").send(xml);
}
