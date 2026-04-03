import { Exchange } from "./core/exchange";
import { WebSocketFeed } from "./core/websocketFeed";
import { Logger } from "./utils/logger";
import type { ITradingStrategy, TickContext } from "./strategies";
import { config } from "./config";

export class TradingBot {
    public exchange: Exchange;
    public symbol: string;
    public latestPrice: number = 0;
    public balanceBTC: number = 0;
    public balanceQuote: number = 0;
    private baseAsset: string;
    private quoteAsset: string;
    private isRunning: boolean = false;
    public strategies: ITradingStrategy[] = [];

    // WebSocket feed
    public wsFeed: WebSocketFeed;

    // Latest order book from WebSocket
    public latestBids: [number, number][] = [];
    public latestAsks: [number, number][] = [];

    // Throttle: don't run strategy on every single trade event
    private lastStrategyRunMs: number = 0;
    private strategyThrottleMs: number = 500; // Run strategy max 2x/sec
    private strategyRunInFlight: boolean = false;
    private pendingStrategyPrice: number | null = null;

    // Balance refresh interval
    private balanceIntervalId: ReturnType<typeof setInterval> | null = null;

    constructor(exchange: Exchange, symbol: string = 'BTCUSDC') {
        this.exchange = exchange;
        this.symbol = symbol;

        // Extract base/quote
        const quoteAssets = ['USDC', 'USDT', 'BUSD', 'EUR'];
        this.quoteAsset = quoteAssets.find(q => symbol.endsWith(q)) || 'USDC';
        this.baseAsset = symbol.replace(this.quoteAsset, '');

        // Create WebSocket feed
        this.wsFeed = new WebSocketFeed(symbol, config.isLive);
    }

    public registerStrategy(strategy: ITradingStrategy) {
        this.strategies.push(strategy);
    }

    public async start() {
        if (this.isRunning) return;
        this.isRunning = true;
        Logger.info(`🤖 Starting bot loop for pair: ${this.symbol}`);

        const isConnected = await this.exchange.ping();
        if (!isConnected) {
            Logger.error("Cannot start bot, failed to connect to Binance.");
            this.isRunning = false;
            return;
        }

        // Fetch initial balances
        await this.refreshBalances();

        // Start balance refresh every 5s (via REST, lightweight)
        this.balanceIntervalId = setInterval(async () => {
            await this.refreshBalances();
        }, 5000);

        // Wire up WebSocket callbacks
        this.wsFeed.onTrade = (price: number, qty: number, isBuyerMaker: boolean) => {
            this.latestPrice = price;

            // Throttle strategy execution to avoid overwhelming
            const now = Date.now();
            if (now - this.lastStrategyRunMs < this.strategyThrottleMs) return;
            this.lastStrategyRunMs = now;

            // Run strategies with latest data
            this.pendingStrategyPrice = price;
            void this.flushStrategyQueue();
        };

        this.wsFeed.onDepth = (bids: [number, number][], asks: [number, number][]) => {
            this.latestBids = bids;
            this.latestAsks = asks;
        };

        this.wsFeed.onBookTicker = (bestBid: number, bestBidQty: number, bestAsk: number, bestAskQty: number) => {
            // BookTicker updates are cached in the feed itself
        };

        // Start the WebSocket connection
        this.wsFeed.start();
    }

    public stop() {
        this.isRunning = false;
        this.wsFeed.stop();
        if (this.balanceIntervalId) {
            clearInterval(this.balanceIntervalId);
        }
        Logger.info(`⏹️ Bot stopped for ${this.symbol}.`);
    }

    private async refreshBalances() {
        try {
            const balances = await this.exchange.getBalances();
            const base = balances.find((b: any) => b.asset === this.baseAsset);
            const quote = balances.find((b: any) => b.asset === this.quoteAsset);
            this.balanceBTC = base ? parseFloat(base.free) : 0;
            this.balanceQuote = quote ? parseFloat(quote.free) : 0;
        } catch (e) {
            // Non-blocking
        }
    }

    private async runStrategies(price: number) {
        const ctx: TickContext = {
            balanceBTC: this.balanceBTC,
            balanceQuote: this.balanceQuote,
            bids: this.latestBids,
            asks: this.latestAsks,
        };

        for (const strategy of this.strategies) {
            try {
                await strategy.onTick(price, this.exchange, this.symbol, ctx);
            } catch (error: any) {
                Logger.error(`Strategy ${strategy.constructor.name} tick failed`, error?.message || error);
            }
        }
    }

    private async flushStrategyQueue() {
        if (this.strategyRunInFlight) return;

        this.strategyRunInFlight = true;
        try {
            while (this.pendingStrategyPrice !== null && this.isRunning) {
                const price = this.pendingStrategyPrice;
                this.pendingStrategyPrice = null;
                await this.runStrategies(price);
            }
        } finally {
            this.strategyRunInFlight = false;

            if (this.pendingStrategyPrice !== null && this.isRunning) {
                void this.flushStrategyQueue();
            }
        }
    }
}
