import { copyFile, mkdtemp, rm } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sendIndexHtml, sendRobotsTxt, sendSitemapXml, siteUrlForRequest } from "./seo";

const indexPath = join(process.cwd(), "index.html");
const alternatePaths = [["en", "/"], ["ko", "/ko"], ["x-default", "/"]];

function request(params: { host?: string; protocol?: string } = {}) {
  return {
    protocol: params.protocol ?? "https",
    get: vi.fn((name: string) => {
      if (name.toLowerCase() === "host") {
        return params.host;
      }

      return undefined;
    })
  } as unknown as Parameters<typeof siteUrlForRequest>[0];
}

function response() {
  return {
    body: "",
    locals: {} as Record<string, unknown>,
    send: vi.fn(function send(this: { body: string }, body: string) {
      this.body = body;
      return this;
    }),
    type: vi.fn(function type(this: unknown) {
      return this;
    })
  } as unknown as Parameters<typeof sendRobotsTxt>[1] & {
    body: string;
    locals: Record<string, unknown>;
  };
}

describe("seo helpers", () => {
  afterEach(() => {
    delete process.env.PUBLIC_SITE_URL;
  });

  it("prefers a configured public site URL", () => {
    process.env.PUBLIC_SITE_URL = "https://road.example.com/path/";

    expect(siteUrlForRequest(request({ host: "internal.example.com" }))).toBe("https://road.example.com/path");
  });

  it("falls back to the request host when no public site URL is configured", () => {
    expect(siteUrlForRequest(request({ host: "road.internal:8787", protocol: "http" }))).toBe("http://road.internal:8787");
  });

  it("publishes the site's own name when the proxy forwarded to a bare address", () => {
    expect(siteUrlForRequest(request({ host: "172.16.0.37:8787", protocol: "http" }))).toBe("https://road.nangman.cloud");
    expect(siteUrlForRequest(request({ host: "10.0.0.4", protocol: "http" }))).toBe("https://road.nangman.cloud");
  });

  it("still lets a configured URL win over a bare address", () => {
    process.env.PUBLIC_SITE_URL = "https://road.example.com";

    expect(siteUrlForRequest(request({ host: "172.16.0.37:8787", protocol: "http" }))).toBe("https://road.example.com");
  });

  it("falls back to localhost when the request has no host", () => {
    process.env.PORT = "8788";

    expect(siteUrlForRequest(request())).toBe("http://127.0.0.1:8788");

    delete process.env.PORT;
  });

  it("renders robots and sitemap with the effective site URL", () => {
    process.env.PUBLIC_SITE_URL = "https://road.example.com";
    const robots = response();
    const sitemap = response();

    sendRobotsTxt(request(), robots);
    sendSitemapXml(request(), sitemap);

    expect(robots.type).toHaveBeenCalledWith("text/plain");
    expect(robots.body).toContain("Sitemap: https://road.example.com/sitemap.xml");
    expect(sitemap.type).toHaveBeenCalledWith("application/xml");
    expect(sitemap.body).toContain("<loc>https://road.example.com/</loc>");
    expect(sitemap.body).toContain("<loc>https://road.example.com/ko</loc>");
    const entries = sitemap.body.match(/<url>[\s\S]*?<\/url>/g) ?? [];
    expect(entries).toHaveLength(2);
    for (const entry of entries) {
      for (const [lang, path] of alternatePaths) {
        expect(entry).toContain(`<xhtml:link rel="alternate" hreflang="${lang}" href="https://road.example.com${path}" />`);
      }
    }
  });

  it("injects canonical and structured data into the built index file", async () => {
    process.env.PUBLIC_SITE_URL = "https://road.example.com";
    const res = response();
    res.locals.cspNonce = "nonce-for-test";

    await sendIndexHtml(request(), res, indexPath);

    expect(res.type).toHaveBeenCalledWith("html");
    expect(res.body).toContain('<link rel="canonical" href="https://road.example.com/" />');
    expect(res.body).toContain('nonce="nonce-for-test"');
    expect(res.body).toContain('"@type":"WebApplication"');
  });
});

describe("public page routes", () => {
  let directory: string;
  let server: typeof import("./index").server;
  let origin: string;
  const publicSite = "https://road.example.com";

  beforeAll(async () => {
    directory = await mkdtemp(join(tmpdir(), "nangman-road-seo-"));
    await copyFile(indexPath, join(directory, "index.html"));
    vi.stubEnv("CLIENT_DIST_DIR", directory);
    vi.stubEnv("PUBLIC_SITE_URL", publicSite);
    vi.stubEnv("PORT", "0");
    ({ server } = await import("./index"));
    const { port } = server.address() as AddressInfo;
    origin = `http://localhost:${port}`;
  });

  afterAll(async () => {
    await server[Symbol.asyncDispose]();
    vi.unstubAllEnvs();
    await rm(directory, { recursive: true });
  });

  it.each([
    { path: "/", lang: "en", locale: "en_US", title: "Nangman Road | Install-free Network Route Visualizer", probe: "nearby network probe" },
    { path: "/ko", lang: "ko", locale: "ko_KR", title: "Nangman Road | 트레이스라우트·MTR 경로 시각화", probe: "가까운 측정 지점" }
  ])("serves the localized head and introduction at $path", async ({ path, lang, locale, title, probe }) => {
    const result = await fetch(origin + path);
    const html = await result.text();
    expect(result.status).toBe(200);
    expect(html).toContain(`<html lang="${lang}">`);
    expect(html.match(/<title>/g)).toHaveLength(1);
    expect(html).toContain(`<title>${title}</title>`);
    expect(html.match(/<meta\s+name="description"/g)).toHaveLength(1);
    const description = /<meta name="description" content="([^"]+)"/.exec(html)?.[1];
    expect(description).toContain(lang === "en" ? "nearby distributed probes" : probe);
    expect(html).toContain(`property="og:title" content="${title}"`);
    expect(html).toContain(`property="og:description" content="${description}"`);
    expect(html).toContain(`property="og:locale" content="${locale}"`);
    expect(html).toContain(`property="og:url" content="${publicSite}${path}"`);
    expect(html).toContain(`name="twitter:title" content="${title}"`);
    expect(html).toContain(`name="twitter:description" content="${description}"`);
    expect(html).toContain(`rel="canonical" href="${publicSite}${path}"`);
    for (const [code, url] of alternatePaths) {
      expect(html).toContain(`rel="alternate" hreflang="${code}" href="${publicSite}${url}"`);
    }
    const json = /<script type="application\/ld\+json"[^>]*>([^<]*)<\/script>/.exec(html);
    expect(JSON.parse(json?.[1] ?? "null")).toMatchObject({ url: publicSite + path, inLanguage: lang, description });
    const root = /<div id="root">([\s\S]+?)<\/div>/.exec(html)?.[1];
    expect(root).toMatch(/<h1[^>]*>Nangman Road<\/h1>/);
    expect(root).toContain(probe);
    expect(root).toContain("Traceroute");
    expect(root).toContain("MTR");
    expect(root).toContain(lang === "en" ? "without installing" : "설치 없이");
  });

  it.each([["/ko/?ref=test", "/ko?ref=test"], ["/index.html", "/"], ["/%69ndex.html", "/"]])(
    "redirects %s before serving static files",
    async (path, location) => {
      const result = await fetch(origin + path, { redirect: "manual" });
      expect(result.status).toBe(301);
      expect(result.headers.get("location")).toBe(location);
    }
  );

  it("serves app HTML for a missing page and JSON for a missing API", async () => {
    const page = await fetch(origin + "/abc");
    expect(page.status).toBe(404);
    expect(await page.text()).toContain('<div id="root"><main');
    const api = await fetch(origin + "/api/abc");
    expect(api.status).toBe(404);
    expect(await api.json()).toEqual({ error: "Not found." });
  });
});
