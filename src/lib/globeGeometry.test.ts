import { describe, expect, it } from "vitest";
import { LABEL_ALTITUDE, RING_ALTITUDE, SURFACE_ALTITUDE, typefaceText } from "./globeGeometry";

// The globe's typeface draws a question mark for every glyph it lacks, so a name has to be
// folded to what it can write before it goes on the map.
describe("names as the globe's typeface can write them", () => {
  it.each([
    ["Belém", "Belem"],
    ["São Paulo", "Sao Paulo"],
    ["Zürich", "Zurich"],
    ["Malmö", "Malmo"],
    ["Kraków", "Krakow"],
    ["İstanbul", "Istanbul"],
    ["Reykjavík", "Reykjavik"],
    ["Košice", "Kosice"],
    ["Timișoara", "Timisoara"]
  ])("folds the accents off %s", (name, written) => {
    expect(typefaceText(name)).toBe(written);
  });

  it.each([
    ["Ålesund", "Alesund"],
    ["Tórshavn", "Torshavn"],
    ["Łódź", "Lodz"],
    ["Ørsta", "Orsta"],
    ["Gjøvik", "Gjovik"]
  ])("spells out the letters that do not decompose, in %s", (name, written) => {
    expect(typefaceText(name)).toBe(written);
  });

  it("leaves a plain name alone", () => {
    expect(typefaceText("Nedonna Beach")).toBe("Nedonna Beach");
  });

  it("writes nothing rather than a row of question marks for a name it cannot draw", () => {
    expect(typefaceText("東京")).toBe("");
    expect(typefaceText("Москва")).toBe("");
  });

  it("never leaves a character the typeface would draw as a question mark", () => {
    const drawable = /^[ -~]*$/;

    for (const name of ["Belém", "São Paulo", "Łódź", "İzmir", "Ærøskøbing", "Straße", "東京"]) {
      expect(typefaceText(name)).toMatch(drawable);
    }
  });
});

// The hover test picks whichever object is nearest the camera, so two layers at one height
// hand the choice to rounding and the tooltip flickers between them.
describe("what the pointer picks where the layers overlap", () => {
  it("puts a place above the leg that runs through it, and the pulse ring below both", () => {
    expect(LABEL_ALTITUDE).toBeGreaterThan(SURFACE_ALTITUDE);
    expect(SURFACE_ALTITUDE).toBeGreaterThan(RING_ALTITUDE);
  });

  it("separates them by far more than the vertex data's own precision", () => {
    // Positions reach the GPU as 32-bit floats, which step by about 8e-6 at this radius.
    const worldGap = (LABEL_ALTITUDE - SURFACE_ALTITUDE) * 100;

    expect(worldGap).toBeGreaterThan(1e-4);
  });

  it("keeps the gap too small to see: under a tenth of the surface height", () => {
    expect(LABEL_ALTITUDE - SURFACE_ALTITUDE).toBeLessThan(SURFACE_ALTITUDE / 10);
    expect(RING_ALTITUDE).toBeGreaterThan(0.0015);
  });
});
