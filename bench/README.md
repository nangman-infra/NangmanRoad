# Route accuracy benchmark

Answers "how good is our geolocation, in numbers" — the thing this project could not
say before. Nobody knows where a backbone router really is, so the two things measured
here are both checkable without that ground truth:

- **Physically possible.** Sum the great-circle distance through the cities a route
  claims, divide by half the last hop's RTT. Light in fibre covers 204,190 km/s
  (`299,792 / 1.4682`). Any route implying more than that is wrong no matter which
  city is at fault.
- **Agrees with the router's own name.** Backbone operators name routers after the
  site they stand in (`ae-3.r24.miamfl02.us.bb.gin.ntt.net` is in Miami). Those hops
  come close to ground truth, so `truth.json` scores placements against them.

`traces/` holds raw traceroute output captured from Globalping probes, kept as fixtures
so a re-score costs nothing but the GeoIP lookups.

```
node bench/collect.mjs      # refresh the fixtures (Globalping, ~2 min)
npx tsx bench/score.mts     # re-score (~130 GeoIP lookups, keep an eye on the ipwho.is quota)
```
