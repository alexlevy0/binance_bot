import { Logger } from "../utils/logger";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), '.binance_bot');
const TRACKER_FILE = join(DATA_DIR, 'tracker.json');

export interface TradeRecord {
    time: number; // Unix timestamp in SECONDS for TradingView
    side: 'BUY' | 'SELL';
    price: number;
    quantity: number;
}

class PerformanceTracker {
    public trades: TradeRecord[] = [];
    public realizedPnl: number = 0;
    private totalWinningTrades: number = 0;
    private totalLosingTrades: number = 0;

    // Simple state to calculate round-trip PnL
    private lastBuyPrice: number | null = null;

    constructor() {
        this.init();
    }

    private init() {
        if (!existsSync(DATA_DIR)) {
            mkdirSync(DATA_DIR, { recursive: true });
        }
        if (existsSync(TRACKER_FILE)) {
            try {
                const data = JSON.parse(readFileSync(TRACKER_FILE, 'utf-8'));
                this.trades = data.trades || [];
                this.realizedPnl = data.realizedPnl || 0;
                this.totalWinningTrades = data.totalWinningTrades || 0;
                this.totalLosingTrades = data.totalLosingTrades || 0;
                this.lastBuyPrice = data.lastBuyPrice || null;
            } catch (e) {
                // ignore JSON errors and start fresh
            }
        }
    }

    private save() {
        try {
            const data = {
                trades: this.trades,
                realizedPnl: this.realizedPnl,
                totalWinningTrades: this.totalWinningTrades,
                totalLosingTrades: this.totalLosingTrades,
                lastBuyPrice: this.lastBuyPrice
            };
            writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            // ignore IO errors
        }
    }

    public addTrade(side: 'BUY' | 'SELL', price: number, quantity: number) {
        this.trades.push({ time: Math.floor(Date.now() / 1000), side, price, quantity });
        Logger.info(`[Tracker] System Logged ${side} Trade at $${price}`);

        if (side === 'BUY') {
            this.lastBuyPrice = price;
        } else if (side === 'SELL' && this.lastBuyPrice !== null) {
            // Realized calculation
            const pnl = (price - this.lastBuyPrice) * quantity;
            this.realizedPnl += pnl;

            if (pnl > 0) {
                this.totalWinningTrades++;
            } else {
                this.totalLosingTrades++;
            }
            this.lastBuyPrice = null;
        }

        this.save(); // Persist to disk seamlessly
    }

    public getWinRate(): number {
        const total = this.totalWinningTrades + this.totalLosingTrades;
        if (total === 0) return 0;
        return (this.totalWinningTrades / total) * 100;
    }

    public getTotalTrades(): number {
        return this.totalWinningTrades + this.totalLosingTrades;
    }
}

// Exported as a singleton
export const Tracker = new PerformanceTracker();
