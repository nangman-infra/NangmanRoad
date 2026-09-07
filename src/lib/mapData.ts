// Static, self-hosted map data (public/data), fetched and parsed once per page and shared by
// the 2D map, the globe and the cable router.
const promises = new Map<string, Promise<unknown>>();

// The build's own id on every data URL: the server lets these files be cached for a day,
// and a rebuilt page must not read the build before it.
export const dataUrl = (name: string) => `/data/${name}.json?v=${__BUILD_ID__}`;

export function loadMapData<T>(name: "cables" | "countries" | "cities"): Promise<T> {
  let promise = promises.get(name) as Promise<T> | undefined;

  if (!promise) {
    promise = fetch(dataUrl(name)).then((response) => response.json() as Promise<T>);
    promises.set(name, promise);
  }

  return promise;
}
