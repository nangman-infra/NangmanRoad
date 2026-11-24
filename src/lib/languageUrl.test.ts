import { describe, expect, it } from "vitest";
import { languageForPath, urlForLanguage, type Lang } from "./i18n";

describe("language entry URLs", () => {
  it.each<Lang>(["ko", "en"])("applies the URL before the %s preference", preferred => {
    expect(languageForPath("/ko", preferred)).toBe("ko");
    expect(languageForPath("/", preferred)).toBe(preferred);
  });

  it.each([
    ["ko", "/", "/ko?q=example#globe-debug"],
    ["en", "/ko", "/?q=example#globe-debug"],
    ["ko", "/ko", undefined],
    ["en", "/", undefined],
    ["ko", "/missing", undefined]
  ] as const)("maps %s at %s to %s", (lang, pathname, expected) => {
    expect(urlForLanguage(lang, { pathname, search: "?q=example", hash: "#globe-debug" })).toBe(expected);
  });
});
