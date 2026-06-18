import { readFile } from "node:fs/promises";
import type { Request, Response } from "express";

const siteName = "Nangman Road";
const pageTitle = "Nangman Road | Install-free Network Route Visualizer";
const pageDescription =
  "Visualize Traceout and MTR-style network routes from nearby distributed probes with an install-free browser experience.";
const imagePath = "/og-image.svg";

let cachedIndexHtml: Promise<string> | undefined;

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function escapeXml(value: string) {
  return escapeHtml(value).replace(/'/g, "&apos;");
}

function trimTrailingSlash(value: string) {
  return value.replace(/\/+$/, "");
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

function requestSiteUrl(req: Request) {
  const host = req.get("host");

  if (!host) {
    return `http://127.0.0.1:${process.env.PORT ?? 8787}`;
  }

  return `${req.protocol}://${host}`;
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
      "Traceout-style route visualization",
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
    `<meta property="og:image:type" content="image/svg+xml" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`,
    `<script type="application/ld+json"${nonceAttribute}>${JSON.stringify(structuredData(siteUrl, imageUrl))}</script>`
  ].join("\n    ");
}

export async function sendIndexHtml(req: Request, res: Response, indexPath: string) {
  cachedIndexHtml ??= readFile(indexPath, "utf8");
  const html = await cachedIndexHtml;

  res.type("html").send(html.replace("</head>", `    ${dynamicHead(req, res)}\n  </head>`));
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
