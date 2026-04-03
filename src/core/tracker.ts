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
    reason?: string;
    marketRegime?: string;
    conviction?: number;
    entryPrice?: number;
    pnlQuote?: number;
    pnlPct?: number;
    netPnlQuote?: number;
    holdDurationSec?: number;
    estimatedFeesQuote?: number;
    estimatedSlippageQuote?: number;
}

export interface OpenPosition {
    entryPrice: number;
    quantity: number;
    openedAtMs?: number;
    reason?: string;
    marketRegime?: string;
    conviction?: number;
    estimatedFeesQuote?: number;
    estimatedSlippageQuote?: number;
}

export interface TradeAnalyticsContext {
    reason?: string;
    marketRegime?: string;
    conviction?: number;
    estimatedFeesQuote?: number;
    estimatedSlippageQuote?: number;
}

class PerformanceTracker {
    public trades: TradeRecord[] = [];
    public realizedPnl: number = 0;
    private totalWinningTrades: number = 0;
    private totalLosingTrades: number = 0;
    private sessionRealizedPnl: number = 0;
    private sessionWinningTrades: number = 0;
    private sessionLosingTrades: number = 0;
    private estimatedFeesQuoteTotal: number = 0;
    private estimatedSlippageQuoteTotal: number = 0;
    private sessionEstimatedFeesQuoteTotal: number = 0;
    private sessionEstimatedSlippageQuoteTotal: number = 0;
    private closedTradeHoldDurationSecTotal: number = 0;
    private sessionClosedTradeHoldDurationSecTotal: number = 0;
    private closedTradesCount: number = 0;
    private sessionClosedTradesCount: number = 0;
    private exitReasonCounts: Record<string, number> = {};
    private openPosition: OpenPosition | null = null;
    private persistenceEnabled: boolean = true;

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
                this.estimatedFeesQuoteTotal = data.estimatedFeesQuoteTotal || 0;
                this.estimatedSlippageQuoteTotal = data.estimatedSlippageQuoteTotal || 0;
                this.closedTradeHoldDurationSecTotal = data.closedTradeHoldDurationSecTotal || 0;
                this.closedTradesCount = data.closedTradesCount || 0;
                this.exitReasonCounts = data.exitReasonCounts || {};
                if (data.openPosition?.entryPrice && data.openPosition?.quantity) {
                    this.openPosition = {
                        entryPrice: data.openPosition.entryPrice,
                        quantity: data.openPosition.quantity,
                        openedAtMs: data.openPosition.openedAtMs,
                        reason: data.openPosition.reason,
                        marketRegime: data.openPosition.marketRegime,
                        conviction: data.openPosition.conviction,
                        estimatedFeesQuote: data.openPosition.estimatedFeesQuote || 0,
                        estimatedSlippageQuote: data.openPosition.estimatedSlippageQuote || 0,
                    };
                } else if (data.lastBuyPrice != null) {
                    const lastBuyTrade = [...this.trades].reverse().find((trade: TradeRecord) => trade.side === 'BUY');
                    if (lastBuyTrade) {
                        this.openPosition = {
                            entryPrice: data.lastBuyPrice,
                            quantity: lastBuyTrade.quantity,
                            openedAtMs: Date.now(),
                            reason: lastBuyTrade.reason,
                            marketRegime: lastBuyTrade.marketRegime,
                            conviction: lastBuyTrade.conviction,
                            estimatedFeesQuote: lastBuyTrade.estimatedFeesQuote || 0,
                            estimatedSlippageQuote: lastBuyTrade.estimatedSlippageQuote || 0,
                        };
                    }
                }
            } catch (e) {
                // ignore JSON errors and start fresh
            }
        }
    }

    private save() {
        if (!this.persistenceEnabled) return;
        try {
            const data = {
                trades: this.trades,
                realizedPnl: this.realizedPnl,
                totalWinningTrades: this.totalWinningTrades,
                totalLosingTrades: this.totalLosingTrades,
                estimatedFeesQuoteTotal: this.estimatedFeesQuoteTotal,
                estimatedSlippageQuoteTotal: this.estimatedSlippageQuoteTotal,
                closedTradeHoldDurationSecTotal: this.closedTradeHoldDurationSecTotal,
                closedTradesCount: this.closedTradesCount,
                exitReasonCounts: this.exitReasonCounts,
                openPosition: this.openPosition,
            };
            writeFileSync(TRACKER_FILE, JSON.stringify(data, null, 2));
        } catch (e) {
            // ignore IO errors
        }
    }

    private formatSigned(value: number, digits: number = 2): string {
        return `${value >= 0 ? '+' : ''}${value.toFixed(digits)}`;
    }

    private formatQuantity(quantity: number): string {
        return quantity.toFixed(5).replace(/\.?0+$/, '');
    }

    private bumpExitReason(reason?: string) {
        const key = reason || 'unknown';
        this.exitReasonCounts[key] = (this.exitReasonCounts[key] || 0) + 1;
    }

    public addTrade(side: 'BUY' | 'SELL', price: number, quantity: number, context: TradeAnalyticsContext = {}) {
        const nowMs = Date.now();
        const time = Math.floor(nowMs / 1000);

        if (side === 'BUY') {
            if (!this.openPosition) {
                this.openPosition = {
                    entryPrice: price,
                    quantity,
                    openedAtMs: nowMs,
                    reason: context.reason,
                    marketRegime: context.marketRegime,
                    conviction: context.conviction,
                    estimatedFeesQuote: context.estimatedFeesQuote || 0,
                    estimatedSlippageQuote: context.estimatedSlippageQuote || 0,
                };
            } else {
                const totalQuantity = this.openPosition.quantity + quantity;
                const weightedEntryPrice = (
                    this.openPosition.entryPrice * this.openPosition.quantity +
                    price * quantity
                ) / totalQuantity;

                this.openPosition = {
                    entryPrice: weightedEntryPrice,
                    quantity: totalQuantity,
                    openedAtMs: this.openPosition.openedAtMs ?? nowMs,
                    reason: context.reason || this.openPosition.reason,
                    marketRegime: context.marketRegime || this.openPosition.marketRegime,
                    conviction: context.conviction ?? this.openPosition.conviction,
                    estimatedFeesQuote: (this.openPosition.estimatedFeesQuote || 0) + (context.estimatedFeesQuote || 0),
                    estimatedSlippageQuote: (this.openPosition.estimatedSlippageQuote || 0) + (context.estimatedSlippageQuote || 0),
                };
            }

            this.trades.push({
                time,
                side,
                price,
                quantity,
                reason: context.reason,
                marketRegime: context.marketRegime,
                conviction: context.conviction,
                estimatedFeesQuote: context.estimatedFeesQuote || 0,
                estimatedSlippageQuote: context.estimatedSlippageQuote || 0,
            });

            Logger.info(
                `[Tracker] BUY @ $${price.toFixed(2)} | Qty:${this.formatQuantity(quantity)} | Avg Entry:$${this.openPosition.entryPrice.toFixed(2)}${context.reason ? ` | ${context.reason}` : ''}`
            );
        } else if (side === 'SELL' && this.openPosition) {
            const openingPosition = { ...this.openPosition };
            const closedQuantity = Math.min(quantity, openingPosition.quantity);
            const pnl = (price - openingPosition.entryPrice) * closedQuantity;
            const pnlPct = openingPosition.entryPrice > 0
                ? ((price - openingPosition.entryPrice) / openingPosition.entryPrice) * 100
                : 0;
            const positionQuantity = Math.max(openingPosition.quantity, closedQuantity, Number.EPSILON);
            const entryFeeShare = (openingPosition.estimatedFeesQuote || 0) * (closedQuantity / positionQuantity);
            const entrySlippageShare = (openingPosition.estimatedSlippageQuote || 0) * (closedQuantity / positionQuantity);
            const exitFeesQuote = context.estimatedFeesQuote || 0;
            const exitSlippageQuote = context.estimatedSlippageQuote || 0;
            const totalEstimatedFees = entryFeeShare + exitFeesQuote;
            const totalEstimatedSlippage = entrySlippageShare + exitSlippageQuote;
            const netPnl = pnl - totalEstimatedFees - totalEstimatedSlippage;
            const holdDurationSec = openingPosition.openedAtMs
                ? Math.max((nowMs - openingPosition.openedAtMs) / 1000, 0)
                : 0;

            this.realizedPnl += pnl;
            this.sessionRealizedPnl += pnl;
            this.estimatedFeesQuoteTotal += totalEstimatedFees;
            this.estimatedSlippageQuoteTotal += totalEstimatedSlippage;
            this.sessionEstimatedFeesQuoteTotal += totalEstimatedFees;
            this.sessionEstimatedSlippageQuoteTotal += totalEstimatedSlippage;
            this.closedTradeHoldDurationSecTotal += holdDurationSec;
            this.sessionClosedTradeHoldDurationSecTotal += holdDurationSec;
            this.closedTradesCount++;
            this.sessionClosedTradesCount++;
            this.bumpExitReason(context.reason);

            if (closedQuantity > 0) {
                if (pnl > 0) {
                    this.totalWinningTrades++;
                    this.sessionWinningTrades++;
                } else {
                    this.totalLosingTrades++;
                    this.sessionLosingTrades++;
                }
            }

            const remainingQuantity = openingPosition.quantity - closedQuantity;
            const remainingFeesQuote = Math.max((openingPosition.estimatedFeesQuote || 0) - entryFeeShare, 0);
            const remainingSlippageQuote = Math.max((openingPosition.estimatedSlippageQuote || 0) - entrySlippageShare, 0);
            this.openPosition = remainingQuantity > 0
                ? {
                    entryPrice: openingPosition.entryPrice,
                    quantity: remainingQuantity,
                    openedAtMs: openingPosition.openedAtMs,
                    reason: openingPosition.reason,
                    marketRegime: openingPosition.marketRegime,
                    conviction: openingPosition.conviction,
                    estimatedFeesQuote: remainingFeesQuote,
                    estimatedSlippageQuote: remainingSlippageQuote,
                }
                : null;

            this.trades.push({
                time,
                side,
                price,
                quantity: closedQuantity,
                reason: context.reason,
                marketRegime: context.marketRegime || openingPosition.marketRegime,
                conviction: context.conviction ?? openingPosition.conviction,
                entryPrice: openingPosition.entryPrice,
                pnlQuote: pnl,
                pnlPct,
                netPnlQuote: netPnl,
                holdDurationSec,
                estimatedFeesQuote: totalEstimatedFees,
                estimatedSlippageQuote: totalEstimatedSlippage,
            });

            const message = `[Tracker] SELL @ $${price.toFixed(2)} | Qty:${this.formatQuantity(closedQuantity)} | P/L:${this.formatSigned(pnlPct)}% (${this.formatSigned(pnl, 4)} $) | Net:${this.formatSigned(netPnl, 4)} $${context.reason ? ` | ${context.reason}` : ''}`;
            if (pnl > 0) {
                Logger.success(message);
            } else if (pnl < 0) {
                Logger.warn(message);
            } else {
                Logger.info(message);
            }
        } else {
            Logger.info(`[Tracker] ${side} @ $${price.toFixed(2)} | Qty:${this.formatQuantity(quantity)}`);
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

    private createSnapshot() {
        return {
            trades: this.trades.map((trade) => ({ ...trade })),
            realizedPnl: this.realizedPnl,
            totalWinningTrades: this.totalWinningTrades,
            totalLosingTrades: this.totalLosingTrades,
            sessionRealizedPnl: this.sessionRealizedPnl,
            sessionWinningTrades: this.sessionWinningTrades,
            sessionLosingTrades: this.sessionLosingTrades,
            estimatedFeesQuoteTotal: this.estimatedFeesQuoteTotal,
            estimatedSlippageQuoteTotal: this.estimatedSlippageQuoteTotal,
            sessionEstimatedFeesQuoteTotal: this.sessionEstimatedFeesQuoteTotal,
            sessionEstimatedSlippageQuoteTotal: this.sessionEstimatedSlippageQuoteTotal,
            closedTradeHoldDurationSecTotal: this.closedTradeHoldDurationSecTotal,
            sessionClosedTradeHoldDurationSecTotal: this.sessionClosedTradeHoldDurationSecTotal,
            closedTradesCount: this.closedTradesCount,
            sessionClosedTradesCount: this.sessionClosedTradesCount,
            exitReasonCounts: { ...this.exitReasonCounts },
            openPosition: this.openPosition ? { ...this.openPosition } : null,
            persistenceEnabled: this.persistenceEnabled,
        };
    }

    private restoreSnapshot(snapshot: ReturnType<typeof PerformanceTracker.prototype.createSnapshot>) {
        this.trades = snapshot.trades.map((trade) => ({ ...trade }));
        this.realizedPnl = snapshot.realizedPnl;
        this.totalWinningTrades = snapshot.totalWinningTrades;
        this.totalLosingTrades = snapshot.totalLosingTrades;
        this.sessionRealizedPnl = snapshot.sessionRealizedPnl;
        this.sessionWinningTrades = snapshot.sessionWinningTrades;
        this.sessionLosingTrades = snapshot.sessionLosingTrades;
        this.estimatedFeesQuoteTotal = snapshot.estimatedFeesQuoteTotal;
        this.estimatedSlippageQuoteTotal = snapshot.estimatedSlippageQuoteTotal;
        this.sessionEstimatedFeesQuoteTotal = snapshot.sessionEstimatedFeesQuoteTotal;
        this.sessionEstimatedSlippageQuoteTotal = snapshot.sessionEstimatedSlippageQuoteTotal;
        this.closedTradeHoldDurationSecTotal = snapshot.closedTradeHoldDurationSecTotal;
        this.sessionClosedTradeHoldDurationSecTotal = snapshot.sessionClosedTradeHoldDurationSecTotal;
        this.closedTradesCount = snapshot.closedTradesCount;
        this.sessionClosedTradesCount = snapshot.sessionClosedTradesCount;
        this.exitReasonCounts = { ...snapshot.exitReasonCounts };
        this.openPosition = snapshot.openPosition ? { ...snapshot.openPosition } : null;
        this.persistenceEnabled = snapshot.persistenceEnabled;
    }

    public async runIsolated<T>(fn: () => Promise<T> | T): Promise<T> {
        const snapshot = this.createSnapshot();

        try {
            this.trades = [];
            this.realizedPnl = 0;
            this.totalWinningTrades = 0;
            this.totalLosingTrades = 0;
            this.sessionRealizedPnl = 0;
            this.sessionWinningTrades = 0;
            this.sessionLosingTrades = 0;
            this.estimatedFeesQuoteTotal = 0;
            this.estimatedSlippageQuoteTotal = 0;
            this.sessionEstimatedFeesQuoteTotal = 0;
            this.sessionEstimatedSlippageQuoteTotal = 0;
            this.closedTradeHoldDurationSecTotal = 0;
            this.sessionClosedTradeHoldDurationSecTotal = 0;
            this.closedTradesCount = 0;
            this.sessionClosedTradesCount = 0;
            this.exitReasonCounts = {};
            this.openPosition = null;
            this.persistenceEnabled = false;
            return await fn();
        } finally {
            this.restoreSnapshot(snapshot);
        }
    }

    public getWinRate(): number {
        const total = this.totalWinningTrades + this.totalLosingTrades;
        if (total === 0) return 0;
        return (this.totalWinningTrades / total) * 100;
    }

    public getTotalTrades(): number {
        return this.totalWinningTrades + this.totalLosingTrades;
    }

    public getSessionWinRate(): number {
        const total = this.sessionWinningTrades + this.sessionLosingTrades;
        if (total === 0) return 0;
        return (this.sessionWinningTrades / total) * 100;
    }

    public getSessionTotalTrades(): number {
        return this.sessionWinningTrades + this.sessionLosingTrades;
    }

    public getSessionRealizedPnl(): number {
        return this.sessionRealizedPnl;
    }

    public getEstimatedCostsQuote(): number {
        return this.estimatedFeesQuoteTotal + this.estimatedSlippageQuoteTotal;
    }

    public getSessionEstimatedCostsQuote(): number {
        return this.sessionEstimatedFeesQuoteTotal + this.sessionEstimatedSlippageQuoteTotal;
    }

    public getCostAdjustedRealizedPnl(): number {
        return this.realizedPnl - this.getEstimatedCostsQuote();
    }

    public getSessionCostAdjustedRealizedPnl(): number {
        return this.sessionRealizedPnl - this.getSessionEstimatedCostsQuote();
    }

    public getAverageHoldDurationSec(): number {
        if (this.closedTradesCount === 0) return 0;
        return this.closedTradeHoldDurationSecTotal / this.closedTradesCount;
    }

    public getSessionAverageHoldDurationSec(): number {
        if (this.sessionClosedTradesCount === 0) return 0;
        return this.sessionClosedTradeHoldDurationSecTotal / this.sessionClosedTradesCount;
    }

    public getExitReasonCounts(): Record<string, number> {
        return { ...this.exitReasonCounts };
    }
}

// Exported as a singleton
export const Tracker = new PerformanceTracker();
