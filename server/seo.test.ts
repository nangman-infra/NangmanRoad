import { mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import { sendIndexHtml, sendRobotsTxt, sendSitemapXml, siteUrlForRequest } from "./seo";

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
  });

  it("injects canonical and structured data into the built index file", async () => {
    process.env.PUBLIC_SITE_URL = "https://road.example.com";
    const directory = await mkdtemp(join(tmpdir(), "nangman-road-seo-"));
    const indexPath = join(directory, "index.html");
    const res = response();
    res.locals.cspNonce = "nonce-for-test";
    await writeFile(indexPath, "<html><head><title>App</title></head><body></body></html>");

    await sendIndexHtml(request(), res, indexPath);

    expect(res.type).toHaveBeenCalledWith("html");
    expect(res.body).toContain('<link rel="canonical" href="https://road.example.com/" />');
    expect(res.body).toContain('nonce="nonce-for-test"');
    expect(res.body).toContain('"@type":"WebApplication"');
  });
});
