import { Logger } from "../utils/logger";
import { TradingBot } from "../bot";
import { OrderBookScalpingStrategy } from "../strategies/orderBookScalping";
import { Tracker } from "../core/tracker";
import { config } from "../config";

export function startDashboard(bot: TradingBot, port: number = 3000) {
    Bun.serve({
        port,
        async fetch(req) {
            const url = new URL(req.url);

            // Serve the visually beautiful UI
            if (url.pathname === "/") {
                const file = Bun.file("./src/server/public/index.html");
                return new Response(file, { headers: { "Content-Type": "text/html" } });
            }

            // API: Historical Klines for Candlestick Charts
            if (url.pathname === "/api/chart") {
                const interval = url.searchParams.get("interval") || '1s';

                let fetchInterval = interval;
                let aggregateFactor = 1;

                // Handle synthetic intervals since Binance Spot API natively rejects 10s, 15s, 30s, 45s
                if (['10s', '15s', '30s', '45s'].includes(interval)) {
                    fetchInterval = '1s';
                    aggregateFactor = parseInt(interval.replace('s', ''));
                }

                // We fetch enough 1s candles to reconstruct the requested count
                // Binance limits 1000 candles max per request, which gives enough buffer for UI charting.
                const limitNeeded = Math.min(1000, 200 * aggregateFactor);
                let klines = await bot.exchange.getChartKlines(bot.symbol, fetchInterval, limitNeeded);

                // Custom Klines Aggregation Engine
                if (aggregateFactor > 1) {
                    const aggregated = [];
                    for (let i = 0; i < klines.length; i += aggregateFactor) {
                        const chunk = klines.slice(i, i + aggregateFactor);
                        if (chunk.length === 0) continue;

                        const time = chunk[0].time;
                        const open = chunk[0].open;
                        const close = chunk[chunk.length - 1].close;
                        const high = Math.max(...chunk.map(c => c.high));
                        const low = Math.min(...chunk.map(c => c.low));

                        aggregated.push({ time, open, high, low, close });
                    }
                    klines = aggregated;
                }

                return new Response(JSON.stringify(klines), {
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
                });
            }

            // API: Executed Trades array for rendering physical markers
            if (url.pathname === "/api/trades") {
                return new Response(JSON.stringify(Tracker.trades), {
                    headers: { "Content-Type": "application/json", "Access-Control-Allow-Origin": "*" }
                });
            }

            // Serve dynamic backend api schema to power widgets
            if (url.pathname === "/api/status") {
                let stratState = "Running";

                // Find the attached OrderBook Strategy to grab its internal textual status
                const obStrat = bot.strategies.find(s => s instanceof OrderBookScalpingStrategy) as OrderBookScalpingStrategy | undefined;
                if (obStrat) {
                    stratState = obStrat.latestState;
                }

                const data = {
                    symbol: bot.symbol,
                    price: bot.latestPrice,
                    state: stratState,
                    regime: obStrat?.latestRegime ?? "BALANCED",
                    todayPnl: bot.todayPnlQuote,
                    todayPnlPct: bot.todayPnlPct,
                    todayPnlSource: bot.todayPnlSource,
                    todayReferenceLabel: bot.todayReferenceLabel,
                    pnl: Tracker.realizedPnl,
                    trackerNetPnl: Tracker.getCostAdjustedRealizedPnl(),
                    trackerEstimatedCosts: Tracker.getEstimatedCostsQuote(),
                    winRate: Tracker.getWinRate(),
                    totalTrades: Tracker.getTotalTrades(),
                    sessionPnl: Tracker.getSessionRealizedPnl(),
                    sessionTrackerNetPnl: Tracker.getSessionCostAdjustedRealizedPnl(),
                    sessionTrackerEstimatedCosts: Tracker.getSessionEstimatedCostsQuote(),
                    sessionWinRate: Tracker.getSessionWinRate(),
                    sessionTotalTrades: Tracker.getSessionTotalTrades(),
                    averageHoldSeconds: Tracker.getAverageHoldDurationSec(),
                    sessionAverageHoldSeconds: Tracker.getSessionAverageHoldDurationSec(),
                    exitReasons: Tracker.getExitReasonCounts(),
                    balanceBTC: bot.balanceBTC,
                    balanceQuote: bot.balanceQuote,
                    obi: obStrat?.latestOBI ?? 0,
                    spread: obStrat?.latestSpread ?? 0,
                    ema: obStrat?.latestEMA ?? 0,
                    logs: Logger.logs,
                    isLive: config.isLive
                };

                return new Response(JSON.stringify(data), {
                    headers: {
                        "Content-Type": "application/json",
                        "Access-Control-Allow-Origin": "*"
                    }
                });
            }

            return new Response("Not Found", { status: 404 });
        }
    });

    Logger.success(`🌐 Web Pro Dashboard running natively at http://localhost:${port}`);
}
