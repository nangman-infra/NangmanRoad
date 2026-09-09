// What is left of the free tiers this deployment runs on. Typing an agreed phrase into the
// search box asks for it instead of measuring - a convenience for whoever runs the server,
// not a login: the phrase never appears here or in the bundle (only its digest does), and the
// server answers 404 to every other caller, including one that guessed the digest. The
// report itself carries counts and clocks, so learning the phrase gains nobody a secret.
export interface BudgetReport {
  measurements: { remaining?: number; total?: number; resetsInSeconds?: number };
  geolocation: {
    cachedAddresses: number;
    ipApi: { remaining?: number; total: number; resetsInSeconds: number };
    calls: Record<string, number>;
    configured: Record<string, boolean>;
    paused: Record<string, number>;
  };
  uptimeSeconds: number;
}

// The phrase this deployment answers to, as its SHA-256. Written here rather than passed in
// at build time: the digest reaches the browser either way - the page cannot recognise the
// phrase without it - so keeping it out of the repository bought nothing and cost a build
// argument, a Dockerfile line and a credential to carry it through Jenkins. The phrase
// itself is on the server and nowhere else, and a digest does not give it back.
const DIGEST = "6032b87f1c677894180c7baab0fbb1ffa308d1344b45a105f02df920db83763f";

async function sha256(text: string) {
  const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

  return [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

// True when what the visitor typed is the phrase this deployment was given. Costs one hash
// of a short string, and answers false at once where no phrase was set or the page is served
// without a secure context, which is where SubtleCrypto is unavailable.
export async function asksForBudget(typed: string) {
  if (!globalThis.crypto?.subtle) {
    return false;
  }

  return (await sha256(typed.trim())) === DIGEST;
}

export async function fetchBudget(key: string): Promise<BudgetReport | undefined> {
  const response = await fetch(`/api/budget?key=${encodeURIComponent(key.trim())}`).catch(() => undefined);

  return response?.ok ? ((await response.json()) as BudgetReport) : undefined;
}
