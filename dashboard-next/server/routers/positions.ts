import { router, publicProcedure } from "../trpc";

function alpacaCredentials() {
  const key = (process.env.APCA_API_KEY_ID || process.env.ALPACA_API_KEY_ID || "").trim();
  const secret = (process.env.APCA_API_SECRET_KEY || process.env.ALPACA_API_SECRET_KEY || "").trim();
  const paper = !["false", "0"].includes(String(process.env.ALPACA_PAPER ?? "true").toLowerCase());
  return { key, secret, paper };
}

export const positionsRouter = router({
  list: publicProcedure.query(async () => {
    const { key, secret, paper } = alpacaCredentials();
    if (!key || !secret) return { enabled: false, paper, positions: [] };

    const base = paper ? "https://paper-api.alpaca.markets" : "https://api.alpaca.markets";
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 12000);
    try {
      const r = await fetch(`${base}/v2/positions`, {
        signal: ctrl.signal,
        headers: { "APCA-API-KEY-ID": key, "APCA-API-SECRET-KEY": secret },
      });
      clearTimeout(t);
      if (!r.ok) return { enabled: true, paper, positions: [], error: "Broker error" };
      const raw: Record<string, string>[] = await r.json();
      const positions = raw.map((p) => ({
        symbol: p.symbol,
        qty: p.qty,
        marketValue: p.market_value,
        costBasis: p.cost_basis,
        unrealizedPl: p.unrealized_pl,
        unrealizedPlpc: p.unrealized_plpc,
        avgEntryPrice: p.avg_entry_price,
        currentPrice: p.current_price,
      }));
      return { enabled: true, paper, positions };
    } catch {
      clearTimeout(t);
      return { enabled: true, paper, positions: [], error: "Could not reach broker" };
    }
  }),
});
