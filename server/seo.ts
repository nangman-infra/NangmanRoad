import { readFile } from "node:fs/promises";
import type { Request, Response } from "express";
import { languagePages, type Lang } from "../src/lib/i18n";

const siteName = "Nangman Road";
const pageDetails = {
  en: {
    locale: "en_US",
    intro: "Explore network routes to a domain or IP address with Traceroute and MTR. A nearby network probe measures the route to your target. View each hop in your browser without installing anything.",
    features: ["Traceroute-style route visualization", "MTR-style network measurement display", "Measured from nearby distributed network probes", "Install-free browser experience"]
  },
  ko: {
    locale: "ko_KR",
    intro: "트레이스라우트(Traceroute)와 MTR로 도메인이나 IP 주소까지의 네트워크 경로를 살펴보세요. 경로 측정은 가까운 측정 지점에서 시작합니다. 별도 설치 없이 브라우저에서 각 홉의 위치와 지연 시간을 확인할 수 있습니다.",
    features: ["트레이스라우트 경로 시각화", "MTR 측정 결과 표시", "가까운 측정 지점에서 출발", "설치 없이 브라우저에서 이용"]
  }
};
// A raster, and not the SVG that stood here: no link-preview scraper - Slack, KakaoTalk,
// X, Facebook, Discord - renders an SVG, so the card came up blank wherever the site was
// shared. JPEG over PNG because the picture is all soft gradient, which costs 750 KB
// lossless and 76 KB here.
const imagePath = "/og-image.jpg";
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

const alternatePaths = {
  en: languagePages.en.path,
  ko: languagePages.ko.path,
  "x-default": languagePages.en.path
};

function alternateLinks(siteUrl: string, tag: "link" | "xhtml:link") {
  return Object.entries(alternatePaths).map(([lang, path]) =>
    `<${tag} rel="alternate" hreflang="${lang}" href="${escapeXml(siteUrl + path)}" />`
  );
}

function structuredData(lang: Lang, canonicalUrl: string, imageUrl: string) {
  return {
    "@context": "https://schema.org",
    "@type": "WebApplication",
    name: siteName,
    url: canonicalUrl,
    inLanguage: lang,
    image: imageUrl,
    applicationCategory: "NetworkingApplication",
    operatingSystem: "Any",
    description: languagePages[lang].description,
    offers: {
      "@type": "Offer",
      price: "0",
      priceCurrency: "USD"
    },
    featureList: pageDetails[lang].features
  };
}

function dynamicHead(req: Request, res: Response, lang: Lang) {
  const siteUrl = siteUrlForRequest(req);
  const page = languagePages[lang];
  const canonicalUrl = siteUrl + page.path;
  const title = escapeHtml(page.title);
  const description = escapeHtml(page.description);
  const imageAlt = `${siteName} - ${page.description}`;
  const imageUrl = `${siteUrl}${imagePath}`;
  const nonce = typeof res.locals.cspNonce === "string" ? res.locals.cspNonce : undefined;
  const nonceAttribute = nonce ? ` nonce="${escapeHtml(nonce)}"` : "";

  const json = JSON.stringify(structuredData(lang, canonicalUrl, imageUrl)).replaceAll("<", "\\u003c");

  return [
    `<title>${title}</title>`,
    `<meta name="description" content="${description}" />`,
    `<meta property="og:title" content="${title}" />`,
    `<meta property="og:description" content="${description}" />`,
    `<meta property="og:locale" content="${pageDetails[lang].locale}" />`,
    `<meta name="twitter:title" content="${title}" />`,
    `<meta name="twitter:description" content="${description}" />`,
    ...alternateLinks(siteUrl, "link"),
    `<link rel="canonical" href="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:url" content="${escapeHtml(canonicalUrl)}" />`,
    `<meta property="og:image" content="${escapeHtml(imageUrl)}" />`,
    `<meta property="og:image:type" content="image/jpeg" />`,
    `<meta property="og:image:alt" content="${escapeHtml(imageAlt)}" />`,
    `<meta property="og:image:width" content="1200" />`,
    `<meta property="og:image:height" content="630" />`,
    `<meta name="twitter:image" content="${escapeHtml(imageUrl)}" />`,
    `<script type="application/ld+json"${nonceAttribute}>${json}</script>`
  ].join("\n    ");
}

function introduction(lang: Lang) {
  return [
    '<div id="root"><main style="min-height:100vh;display:grid;place-content:center;padding:1.5rem;background:#050812;color:#f8fbff;text-align:center">',
    '<h1 style="font-size:2rem;font-weight:600">Nangman Road</h1>',
    `<p style="max-width:40rem;margin:1rem auto;line-height:1.6">${escapeHtml(pageDetails[lang].intro)}</p>`,
    "</main></div>"
  ].join("\n");
}

export async function sendIndexHtml(req: Request, res: Response, indexPath: string) {
  cachedIndexHtml ??= readFile(indexPath, "utf8");
  const html = await cachedIndexHtml;

  const lang = req.path === languagePages.ko.path ? "ko" : "en";
  const page = html
    .replace('<html lang="en">', `<html lang="${lang}">`)
    .replace(/<!--page-head-->[\s\S]*?<!--\/page-head-->/, () => dynamicHead(req, res, lang))
    .replace('<div id="root"></div>', () => introduction(lang));

  res.type("html").send(page);
}

export function sendRobotsTxt(req: Request, res: Response) {
  const siteUrl = siteUrlForRequest(req);

  res.type("text/plain").send(`User-agent: *\nAllow: /\nSitemap: ${siteUrl}/sitemap.xml\n`);
}

export function sendSitemapXml(req: Request, res: Response) {
  const siteUrl = siteUrlForRequest(req);
  const links = alternateLinks(siteUrl, "xhtml:link");
  const urls = Object.values(languagePages).map(({ path }) => [
    "  <url>",
    `    <loc>${escapeXml(siteUrl + path)}</loc>`,
    ...links,
    "    <changefreq>weekly</changefreq>",
    "    <priority>1.0</priority>",
    "  </url>"
  ].join("\n"));
  const xml = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9" xmlns:xhtml="http://www.w3.org/1999/xhtml">',
    ...urls,
    "</urlset>"
  ].join("\n");

  res.type("application/xml").send(xml);
}
