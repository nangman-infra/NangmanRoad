// What a hover over a drawn stretch says. Shared by the flat map and the globe, so the
// two never disagree. It separates what was measured (the hops) from what was inferred
// (which cable, where it came ashore, and that the land parts follow corridors because
// land fibre routes are not public data), and ends with the evidence behind the verdict.
import type { LegEvidence } from "./cableRouting";
import { t } from "./i18n";
import { speedBand } from "./latency";

export interface LabelledLeg {
  kind: "sea" | "land" | "direct";
  cables?: string[];
  // The landing stations at the stretch's ends, where known.
  from?: string;
  to?: string;
  // A straight line that has to cross water, drawn so because no cable chain was found.
  crossing?: boolean;
  // Why the leg was decided the way it was.
  evidence?: LegEvidence[];
  // How fast the packet crossed the hop leg this stretch belongs to, km/s.
  kmps?: number;
}

// The last line of a hover: the speed the colour stands for, in the legend's words.
export function legSpeed(leg: Pick<LabelledLeg, "kmps">) {
  return leg.kmps === undefined || !Number.isFinite(leg.kmps) || leg.kmps <= 0 ? t("leg.speedNone") : t("leg.speed", { band: t(`hud.${speedBand(leg.kmps)}`) });
}

export function formatEvidence(item: LegEvidence): string {
  switch (item.code) {
    case "open_water":
    case "bridged_water":
      return t(`why.${item.code}`, { km: item.km });
    case "no_chain_within":
      return t("why.no_chain_within", { ratio: item.ratio, rtt: item.rttMs === undefined ? "" : t("why.no_chain_within.rtt", { ms: item.rttMs }) });
    case "owner":
      return t("why.owner", { operator: item.operator, cables: item.cables.join(", ") });
    case "fits_rtt":
      return t("why.fits_rtt", { ms: item.rttMs });
    default:
      return t(`why.${item.code}`);
  }
}

// The third line of a hover: the evidence behind the verdict, or nothing.
export function legWhy(leg: LabelledLeg) {
  return leg.evidence?.length ? t("leg.why", { reasons: leg.evidence.map(formatEvidence).join("; ") }) : undefined;
}

export function legLabel(leg: LabelledLeg): { title: string; meta: string; why?: string; speed: string } {
  if (leg.kind === "sea") {
    const systems = leg.cables?.length ? leg.cables.join(" → ") : t("leg.seaUnknown");
    const shore = leg.from && leg.to ? `${leg.from} → ${leg.to}` : leg.from ? `${leg.from} →` : leg.to ? `→ ${leg.to}` : "";

    return { title: t("leg.sea"), meta: shore ? `${systems} · ${shore}` : systems, why: legWhy(leg), speed: legSpeed(leg) };
  }

  if (leg.kind === "land" && leg.cables?.length && !leg.from && !leg.to) {
    return { title: t("leg.land"), meta: t("leg.terrestrialMeta", { cables: leg.cables.join(" → ") }), why: legWhy(leg), speed: legSpeed(leg) };
  }

  if (leg.kind === "land") {
    const between =
      leg.from && leg.to
        ? t("leg.betweenLandings", { from: leg.from, to: leg.to })
        : leg.from
          ? t("leg.fromLanding", { from: leg.from })
          : leg.to
            ? t("leg.toLanding", { to: leg.to })
            : t("leg.betweenLandingHop");

    return { title: t("leg.land"), meta: t("leg.landMeta", { between }), why: legWhy(leg), speed: legSpeed(leg) };
  }

  if (leg.crossing) {
    return { title: t("leg.straight"), meta: t("leg.straightMeta"), why: legWhy(leg), speed: legSpeed(leg) };
  }

  return { title: t("leg.direct"), meta: t("leg.directMeta"), why: legWhy(leg), speed: legSpeed(leg) };
}
