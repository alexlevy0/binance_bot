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

export interface OpenPosition {
    entryPrice: number;
    quantity: number;
}

class PerformanceTracker {
    public trades: TradeRecord[] = [];
    public realizedPnl: number = 0;
    private totalWinningTrades: number = 0;
    private totalLosingTrades: number = 0;
    private openPosition: OpenPosition | null = null;

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
                if (data.openPosition?.entryPrice && data.openPosition?.quantity) {
                    this.openPosition = {
                        entryPrice: data.openPosition.entryPrice,
                        quantity: data.openPosition.quantity,
                    };
                } else if (data.lastBuyPrice != null) {
                    const lastBuyTrade = [...this.trades].reverse().find((trade: TradeRecord) => trade.side === 'BUY');
                    if (lastBuyTrade) {
                        this.openPosition = {
                            entryPrice: data.lastBuyPrice,
                            quantity: lastBuyTrade.quantity,
                        };
                    }
                }
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
                openPosition: this.openPosition,
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
            if (!this.openPosition) {
                this.openPosition = { entryPrice: price, quantity };
            } else {
                const totalQuantity = this.openPosition.quantity + quantity;
                const weightedEntryPrice = (
                    this.openPosition.entryPrice * this.openPosition.quantity +
                    price * quantity
                ) / totalQuantity;

                this.openPosition = {
                    entryPrice: weightedEntryPrice,
                    quantity: totalQuantity,
                };
            }
        } else if (side === 'SELL' && this.openPosition) {
            const closedQuantity = Math.min(quantity, this.openPosition.quantity);
            const pnl = (price - this.openPosition.entryPrice) * closedQuantity;
            this.realizedPnl += pnl;

            if (closedQuantity > 0) {
                if (pnl > 0) {
                    this.totalWinningTrades++;
                } else {
                    this.totalLosingTrades++;
                }
            }

            const remainingQuantity = this.openPosition.quantity - closedQuantity;
            this.openPosition = remainingQuantity > 0
                ? { entryPrice: this.openPosition.entryPrice, quantity: remainingQuantity }
                : null;
        }

        this.save(); // Persist to disk seamlessly
    }

    public getOpenPosition(): OpenPosition | null {
        if (!this.openPosition) return null;
        return { ...this.openPosition };
    }

    public setOpenPosition(position: OpenPosition | null) {
        this.openPosition = position ? { ...position } : null;
        this.save();
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
