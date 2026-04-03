import { Exchange } from "./core/exchange";
import { Logger } from "./utils/logger";
import type { ITradingStrategy } from "./strategies";

export class TradingBot {
    public exchange: Exchange;
    public symbol: string;
    public latestPrice: number = 0;
    private intervalId: ReturnType<typeof setInterval> | null = null;
    private isRunning: boolean = false;
    private intervalMs: number;
    public strategies: ITradingStrategy[] = [];

    constructor(exchange: Exchange, symbol: string = 'BTCUSDT', intervalMs: number = 10000) {
        this.exchange = exchange;
        this.symbol = symbol;
        this.intervalMs = intervalMs;
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

        this.intervalId = setInterval(async () => {
            await this.tick();
        }, this.intervalMs);

        // Initial tick
        await this.tick();
    }

    public stop() {
        this.isRunning = false;
        if (this.intervalId) {
            clearInterval(this.intervalId);
        }
        Logger.info(`⏹️ Bot stopped for ${this.symbol}.`);
    }

    private async tick() {
        try {
            // 1. Fetch current ticker price
            const currentPrice = await this.exchange.getTickerPrice(this.symbol);
            this.latestPrice = currentPrice;
            Logger.info(`${this.symbol} Price: ${currentPrice}`);

            // 2. Dispatch price tick to all registered strategies
            for (const strategy of this.strategies) {
                await strategy.onTick(currentPrice, this.exchange);
            }

        } catch (error: any) {
            Logger.error("Tick failed", error.message);
        }
    }
}
