import type { ITradingStrategy, TickContext } from "./index";
import { Exchange } from "../core/exchange";
import { Logger } from "../utils/logger";
import { Tracker } from "../core/tracker";

type MarketRegime = 'TREND' | 'BALANCED' | 'CHOP' | 'THIN' | 'HOSTILE' | 'HALTED';

interface SmoothedBookState {
    smoothedObi: number;
    smoothedTopObi: number;
    smoothedSpreadPct: number;
    smoothedMicroPriceEdgePct: number;
    smoothedDepthRatio: number;
    smoothedBidConsumption: number;
    smoothedAskConsumption: number;
    smoothedAbsorptionBias: number;
    smoothedNearDepthShare: number;
    obiStdDev: number;
    microStdDev: number;
    obiSlope: number;
    topObiSlope: number;
}

interface MarketRegimeAssessment {
    regime: MarketRegime;
    allowEntries: boolean;
    riskMultiplier: number;
    minScoreAdjustment: number;
    note: string;
}

export interface OrderBookScalpingTuning {
    maxPositionNotional?: number;
    baseRiskAllocation?: number;
    scoreRiskBonus?: number;
    minRiskAllocation?: number;
    maxRiskAllocation?: number;
    dailyLossLimitQuote?: number;
    dailyCautionLossQuote?: number;
    bookSignalWindow?: number;
    minAtrPct?: number;
    maxTickVelocityPct?: number;
    topObiEntryThreshold?: number;
    depthRatioEntryThreshold?: number;
    persistenceAskConsumptionThreshold?: number;
    thinNearDepthShareThreshold?: number;
    hostileBidConsumptionThreshold?: number;
    absorptionBiasThreshold?: number;
    entryConfirmationTicksRequired?: number;
    stagnationTicks?: number;
    stagnationMaxPnlPct?: number;
    stagnationObiThreshold?: number;
}

/**
 * OrderBookScalpingStrategy v2 — Pro Edition
 * 
 * Professional-grade scalping with 10 integrated techniques:
 * 1. Order Book Imbalance (OBI) — Bid vs Ask volume pressure
 * 2. Spread Analysis — Only trades during tight spreads
 * 3. Dual EMA Crossover — Fast(5) vs Slow(20) momentum confirmation
 * 4. Dynamic TP/SL — Adapts to current market volatility
 * 5. Smart Sizing — Uses actual balance for position sizing
 * 6. Existing Position Detection — Recognizes BTC already held
 * 7. 📈 Trailing Stop-Loss — Locks in profits as price rises
 * 8. 📊 VWAP — Buy below volume-weighted price, sell above
 * 9. 🔥 Absorption Detection — Detects wall eating in the book
 * 10. 🌊 Anti-Chop ATR Filter — Avoids flat/choppy markets
 * 11. 🎯 Tick Velocity Filter — Rejects artificial spikes
 */
export class OrderBookScalpingStrategy implements ITradingStrategy {
    private positionOpen: boolean = false;
    private buyPrice: number = 0;
    private actualQuantity: number = 0;
    private untrackedWalletPositionSeen: boolean = false;
    private exchangeMinNotional: number = 0;
    private exchangeMinQty: number = 0;
    private exchangeStepSize: number = 0;
    private exchangeRulesLoadedSymbol: string | null = null;
    private exitBlockedByNotional: boolean = false;
    private entrySafetyMultiplier: number = 1.05;
    private exitSafetyMultiplier: number = 1.01;
    private currentTrailingPct: number = 0.0004;
    private breakEvenArmed: boolean = false;
    private breakEvenTriggerPrice: number = 0;
    private breakEvenPrice: number = 0;
    private tradeConviction: number = 0;
    private tpExtensionsUsed: number = 0;
    private maxTpExtensions: number = 1;
    private maxPositionNotional: number = 18;
    private baseRiskAllocation: number = 0.18;
    private scoreRiskBonus: number = 0.16;
    private lossPenaltyPerStreak: number = 0.10;
    private dustIgnoreRatio: number = 0.35;
    private buyBalanceSafetyFactor: number = 0.985;
    private buyPriceSafetyMultiplier: number = 1.0015;
    private minRiskAllocation: number = 0.12;
    private maxRiskAllocation: number = 0.42;
    private riskPauseTicks: number = 0;
    private dailyLossLimitQuote: number = 1.5;
    private dailyCautionLossQuote: number = 0.75;
    private dailyRealizedPnl: number = 0;
    private dailyTradeCount: number = 0;
    private activeDayKey: string = '';
    private marketRegime: MarketRegime = 'BALANCED';
    private bookSignalWindow: number = 12;
    private obiHistory: number[] = [];
    private topObiHistory: number[] = [];
    private spreadHistory: number[] = [];
    private microPriceEdgeHistory: number[] = [];
    private depthRatioHistory: number[] = [];
    private nearDepthShareHistory: number[] = [];
    private bidConsumptionHistory: number[] = [];
    private askConsumptionHistory: number[] = [];
    private absorptionBiasHistory: number[] = [];
    private lastBestBidQty: number = 0;
    private lastBestAskQty: number = 0;
    private estimatedFeeRate: number = 0.001;
    private estimatedSlippageRate: number = 0.00025;
    private topObiEntryThreshold: number = 0.56;
    private depthRatioEntryThreshold: number = 1.08;
    private persistenceAskConsumptionThreshold: number = 0.04;
    private thinNearDepthShareThreshold: number = 0.18;
    private hostileBidConsumptionThreshold: number = 0.18;
    private absorptionBiasThreshold: number = 0.10;
    private entryConfirmationTicksRequired: number = 2;
    private entryConfirmationCount: number = 0;
    private entryConfirmationRegime: MarketRegime | null = null;
    private entryConfirmationAnchorPrice: number = 0;
    private ticksInPosition: number = 0;
    private stagnationTicks: number = 18;
    private stagnationMaxPnlPct: number = 0.012;
    private stagnationObiThreshold: number = 0.535;

    // ── Dual EMA State ──
    private emaFast: number = 0;       // Fast EMA (5 ticks)
    private emaSlow: number = 0;       // Slow EMA (20 ticks)
    private emaFastPeriod: number = 5;
    private emaSlowPeriod: number = 20;
    private tickCount: number = 0;

    // ── Trailing Stop ──
    private trailingStopPrice: number = 0;
    private highestPriceSinceEntry: number = 0;
    private trailingStopPct: number = 0.0004; // 0.04% trail distance

    // ── Dynamic TP/SL ──
    private takeProfitPrice: number = 0;
    private stopLossPrice: number = 0;

    // ── ATR (Anti-Chop Filter) ──
    private priceHistory: number[] = [];
    private atrPeriod: number = 14;
    private minAtrPct: number = 0.002; // Minimum 0.002% ATR to trade

    // ── Tick Velocity ──
    private lastPrice: number = 0;
    private maxTickVelocityPct: number = 0.05; // Reject > 0.05% jumps

    // ── Absorption Detection ──
    private lastBidWallVolume: number = 0;
    private lastAskWallVolume: number = 0;

    // ── VWAP ──
    private vwapNumerator: number = 0;
    private vwapDenominator: number = 0;
    private vwapValue: number = 0;

    // ── Cooldown ──
    private cooldownTicks: number = 0;

    // ── Win/Loss Streak Tracking ──
    private consecutiveLosses: number = 0;
    private maxConsecutiveLosses: number = 3; // After 3 losses, increase cooldown

    // ── Public Dashboard State ──
    public latestState: string = "Initialisation...";
    public latestOBI: number = 0;
    public latestSpread: number = 0;
    public latestEMA: number = 0;
    public latestConviction: number = 0;
    public latestRegime: string = "BALANCED";

    // ── Config ──
    private maxSpreadPct: number;
    private obiThreshold: number;
    private obiExitThreshold: number;
    private tpMultiplier: number;
    private slMultiplier: number;
    private minNotional: number;
    private minScore: number;

    constructor(
        maxSpreadPct: number = 0.05,
        obiThreshold: number = 0.58,
        obiExitThreshold: number = 0.38,
        tpMultiplier: number = 4.2,
        slMultiplier: number = 2.2,
        minNotional: number = 6.0,
        minScore: number = 8,
        tuning: OrderBookScalpingTuning = {}
    ) {
        this.maxSpreadPct = maxSpreadPct;
        this.obiThreshold = obiThreshold;
        this.obiExitThreshold = obiExitThreshold;
        this.tpMultiplier = tpMultiplier;
        this.slMultiplier = slMultiplier;
        this.minNotional = minNotional;
        this.minScore = minScore;
        this.applyTuning(tuning);
    }

    private applyTuning(tuning: OrderBookScalpingTuning) {
        if (tuning.maxPositionNotional != null) this.maxPositionNotional = tuning.maxPositionNotional;
        if (tuning.baseRiskAllocation != null) this.baseRiskAllocation = tuning.baseRiskAllocation;
        if (tuning.scoreRiskBonus != null) this.scoreRiskBonus = tuning.scoreRiskBonus;
        if (tuning.minRiskAllocation != null) this.minRiskAllocation = tuning.minRiskAllocation;
        if (tuning.maxRiskAllocation != null) this.maxRiskAllocation = tuning.maxRiskAllocation;
        if (tuning.dailyLossLimitQuote != null) {
            this.dailyLossLimitQuote = tuning.dailyLossLimitQuote;
            if (tuning.dailyCautionLossQuote == null) {
                this.dailyCautionLossQuote = Math.max(0.5, tuning.dailyLossLimitQuote * 0.5);
            }
        }
        if (tuning.dailyCautionLossQuote != null) this.dailyCautionLossQuote = tuning.dailyCautionLossQuote;
        if (tuning.bookSignalWindow != null) this.bookSignalWindow = Math.max(4, Math.round(tuning.bookSignalWindow));
        if (tuning.minAtrPct != null) this.minAtrPct = tuning.minAtrPct;
        if (tuning.maxTickVelocityPct != null) this.maxTickVelocityPct = tuning.maxTickVelocityPct;
        if (tuning.topObiEntryThreshold != null) this.topObiEntryThreshold = tuning.topObiEntryThreshold;
        if (tuning.depthRatioEntryThreshold != null) this.depthRatioEntryThreshold = tuning.depthRatioEntryThreshold;
        if (tuning.persistenceAskConsumptionThreshold != null) this.persistenceAskConsumptionThreshold = tuning.persistenceAskConsumptionThreshold;
        if (tuning.thinNearDepthShareThreshold != null) this.thinNearDepthShareThreshold = tuning.thinNearDepthShareThreshold;
        if (tuning.hostileBidConsumptionThreshold != null) this.hostileBidConsumptionThreshold = tuning.hostileBidConsumptionThreshold;
        if (tuning.absorptionBiasThreshold != null) this.absorptionBiasThreshold = tuning.absorptionBiasThreshold;
        if (tuning.entryConfirmationTicksRequired != null) this.entryConfirmationTicksRequired = Math.max(1, Math.round(tuning.entryConfirmationTicksRequired));
        if (tuning.stagnationTicks != null) this.stagnationTicks = Math.max(4, Math.round(tuning.stagnationTicks));
        if (tuning.stagnationMaxPnlPct != null) this.stagnationMaxPnlPct = tuning.stagnationMaxPnlPct;
        if (tuning.stagnationObiThreshold != null) this.stagnationObiThreshold = tuning.stagnationObiThreshold;
    }

    // ── EMA Calculation ──
    private updateEMA(price: number) {
        this.tickCount++;
        if (this.tickCount === 1) {
            this.emaFast = price;
            this.emaSlow = price;
        } else {
            const kFast = 2 / (this.emaFastPeriod + 1);
            const kSlow = 2 / (this.emaSlowPeriod + 1);
            this.emaFast = price * kFast + this.emaFast * (1 - kFast);
            this.emaSlow = price * kSlow + this.emaSlow * (1 - kSlow);
        }
        this.latestEMA = this.emaFast;
    }

    // ── ATR Calculation (Average True Range) ──
    private updateATR(price: number): number {
        this.priceHistory.push(price);
        if (this.priceHistory.length > this.atrPeriod + 1) {
            this.priceHistory.shift();
        }
        if (this.priceHistory.length < 2) return 0;

        let totalRange = 0;
        for (let i = 1; i < this.priceHistory.length; i++) {
            totalRange += Math.abs(this.priceHistory[i]! - this.priceHistory[i - 1]!);
        }
        return (totalRange / (this.priceHistory.length - 1)) / price * 100; // ATR as %
    }

    private pushRollingValue(history: number[], value: number) {
        history.push(value);
        if (history.length > this.bookSignalWindow) {
            history.shift();
        }
    }

    private getAverage(values: number[]): number {
        if (values.length === 0) return 0;
        return values.reduce((sum, value) => sum + value, 0) / values.length;
    }

    private getSlope(values: number[]): number {
        if (values.length < 2) return 0;
        return (values[values.length - 1]! - values[0]!) / (values.length - 1);
    }

    private getStandardDeviation(values: number[]): number {
        if (values.length < 2) return 0;
        const mean = this.getAverage(values);
        const variance = values.reduce((sum, value) => sum + Math.pow(value - mean, 2), 0) / values.length;
        return Math.sqrt(variance);
    }

    private getLocalDayKey(): string {
        return new Date().toLocaleDateString('en-CA');
    }

    private refreshDailyRiskState() {
        const dayKey = this.getLocalDayKey();
        if (this.activeDayKey === dayKey) {
            return;
        }

        this.activeDayKey = dayKey;
        this.dailyRealizedPnl = 0;
        this.dailyTradeCount = 0;
        this.riskPauseTicks = 0;
        Logger.info(`[Risk] Nouvelle session journaliere ${dayKey}, compteurs reinitialises.`);
    }

    private resetEntryConfirmation() {
        this.entryConfirmationCount = 0;
        this.entryConfirmationRegime = null;
        this.entryConfirmationAnchorPrice = 0;
    }

    private advanceEntryConfirmation(price: number, regime: MarketRegime): boolean {
        const anchorDriftPct = this.entryConfirmationAnchorPrice > 0
            ? Math.abs((price - this.entryConfirmationAnchorPrice) / this.entryConfirmationAnchorPrice) * 100
            : 0;
        const sameSetup =
            this.entryConfirmationCount > 0 &&
            this.entryConfirmationRegime === regime &&
            anchorDriftPct <= this.maxSpreadPct * 1.5;

        if (!sameSetup) {
            this.entryConfirmationCount = 0;
            this.entryConfirmationRegime = regime;
            this.entryConfirmationAnchorPrice = price;
        }

        this.entryConfirmationCount++;
        return this.entryConfirmationCount >= this.entryConfirmationTicksRequired;
    }

    private estimateExecutionCosts(notional: number, conviction: number, exitPressure: number = 0): { feesQuote: number, slippageQuote: number } {
        const safeNotional = Math.max(notional, 0);
        const feesQuote = safeNotional * this.estimatedFeeRate;
        const convictionDiscount = conviction > 0 ? conviction * 0.20 : 0;
        const effectiveSlippageRate = this.estimatedSlippageRate * (1 + Math.max(exitPressure, 0)) * Math.max(0.7, 1 - convictionDiscount);
        return {
            feesQuote,
            slippageQuote: safeNotional * effectiveSlippageRate,
        };
    }

    private getConsumptionRatio(previousQty: number, currentQty: number): number {
        if (previousQty <= 0 || currentQty >= previousQty) {
            return 0;
        }
        return (previousQty - currentQty) / previousQty;
    }

    private updateSmoothedBookState(
        obi: number,
        topObi: number,
        spreadPct: number,
        microPriceEdgePct: number,
        depthRatio: number,
        nearDepthShare: number,
        bestBidQty: number,
        bestAskQty: number,
        absorption: { bullish: boolean, bearish: boolean }
    ): SmoothedBookState {
        const bidConsumption = this.getConsumptionRatio(this.lastBestBidQty, bestBidQty);
        const askConsumption = this.getConsumptionRatio(this.lastBestAskQty, bestAskQty);
        const absorptionBias = absorption.bullish ? 1 : absorption.bearish ? -1 : 0;

        this.lastBestBidQty = bestBidQty;
        this.lastBestAskQty = bestAskQty;

        this.pushRollingValue(this.obiHistory, obi);
        this.pushRollingValue(this.topObiHistory, topObi);
        this.pushRollingValue(this.spreadHistory, spreadPct);
        this.pushRollingValue(this.microPriceEdgeHistory, microPriceEdgePct);
        this.pushRollingValue(this.depthRatioHistory, depthRatio);
        this.pushRollingValue(this.nearDepthShareHistory, nearDepthShare);
        this.pushRollingValue(this.bidConsumptionHistory, bidConsumption);
        this.pushRollingValue(this.askConsumptionHistory, askConsumption);
        this.pushRollingValue(this.absorptionBiasHistory, absorptionBias);

        return {
            smoothedObi: this.getAverage(this.obiHistory),
            smoothedTopObi: this.getAverage(this.topObiHistory),
            smoothedSpreadPct: this.getAverage(this.spreadHistory),
            smoothedMicroPriceEdgePct: this.getAverage(this.microPriceEdgeHistory),
            smoothedDepthRatio: this.getAverage(this.depthRatioHistory),
            smoothedBidConsumption: this.getAverage(this.bidConsumptionHistory),
            smoothedAskConsumption: this.getAverage(this.askConsumptionHistory),
            smoothedAbsorptionBias: this.getAverage(this.absorptionBiasHistory),
            smoothedNearDepthShare: this.getAverage(this.nearDepthShareHistory),
            obiStdDev: this.getStandardDeviation(this.obiHistory),
            microStdDev: this.getStandardDeviation(this.microPriceEdgeHistory),
            obiSlope: this.getSlope(this.obiHistory),
            topObiSlope: this.getSlope(this.topObiHistory),
        };
    }

    private assessMarketRegime(
        atrPct: number,
        emaGapPct: number,
        smoothed: SmoothedBookState
    ): MarketRegimeAssessment {
        const thinMarket =
            smoothed.smoothedSpreadPct > this.maxSpreadPct * 0.92 ||
            (smoothed.smoothedNearDepthShare < this.thinNearDepthShareThreshold && smoothed.smoothedSpreadPct > this.maxSpreadPct * 0.70);
        const chopMarket =
            atrPct < this.minAtrPct * 1.25 ||
            (
                Math.abs(smoothed.smoothedObi - 0.5) < 0.03 &&
                Math.abs(emaGapPct) < Math.max(smoothed.smoothedSpreadPct * 0.35, 0.003) &&
                smoothed.obiStdDev < 0.018 &&
                smoothed.microStdDev < 0.0012
            );
        const hostileMarket =
            smoothed.smoothedObi < 0.49 &&
            smoothed.smoothedTopObi < 0.49 &&
            smoothed.smoothedMicroPriceEdgePct < -0.0006 &&
            smoothed.smoothedBidConsumption > this.hostileBidConsumptionThreshold &&
            smoothed.smoothedAbsorptionBias < -this.absorptionBiasThreshold;
        const trendMarket =
            !thinMarket &&
            !hostileMarket &&
            smoothed.smoothedObi > this.obiThreshold - 0.01 &&
            smoothed.smoothedTopObi > 0.55 &&
            smoothed.smoothedMicroPriceEdgePct > 0 &&
            smoothed.smoothedDepthRatio > 1.03 &&
            emaGapPct > Math.max(smoothed.smoothedSpreadPct * 0.30, 0.003) &&
            smoothed.obiSlope >= -0.001;

        if (this.dailyRealizedPnl <= -this.dailyLossLimitQuote) {
            return {
                regime: 'HALTED',
                allowEntries: false,
                riskMultiplier: 0,
                minScoreAdjustment: 99,
                note: `Daily stop ${this.dailyRealizedPnl.toFixed(2)}$`,
            };
        }

        if (thinMarket) {
            return {
                regime: 'THIN',
                allowEntries: false,
                riskMultiplier: 0,
                minScoreAdjustment: 99,
                note: `Thin spread:${smoothed.smoothedSpreadPct.toFixed(3)}%`,
            };
        }

        if (hostileMarket) {
            return {
                regime: 'HOSTILE',
                allowEntries: false,
                riskMultiplier: 0,
                minScoreAdjustment: 99,
                note: `Hostile OBI:${(smoothed.smoothedObi * 100).toFixed(1)}%`,
            };
        }

        if (chopMarket) {
            return {
                regime: 'CHOP',
                allowEntries: false,
                riskMultiplier: 0,
                minScoreAdjustment: 99,
                note: `Chop ATR:${atrPct.toFixed(4)}%`,
            };
        }

        if (trendMarket) {
            return {
                regime: 'TREND',
                allowEntries: true,
                riskMultiplier: this.dailyRealizedPnl <= -this.dailyCautionLossQuote ? 0.72 : 1,
                minScoreAdjustment: 0,
                note: `Trend OBI:${(smoothed.smoothedObi * 100).toFixed(1)}%`,
            };
        }

        return {
            regime: 'BALANCED',
            allowEntries: true,
            riskMultiplier: this.dailyRealizedPnl <= -this.dailyCautionLossQuote ? 0.45 : 0.62,
            minScoreAdjustment: 1,
            note: 'Balanced',
        };
    }

    private recordClosedTradeOutcome(pnlQuote: number, reason: string) {
        this.refreshDailyRiskState();
        this.dailyRealizedPnl += pnlQuote;
        this.dailyTradeCount++;

        if (this.dailyRealizedPnl <= -this.dailyLossLimitQuote) {
            Logger.warn(`[Risk] Daily stop active apres ${reason}: ${this.dailyRealizedPnl.toFixed(2)}$`);
            this.riskPauseTicks = 0;
            return;
        }

        if (pnlQuote < 0) {
            this.riskPauseTicks = Math.max(this.riskPauseTicks, this.consecutiveLosses >= this.maxConsecutiveLosses ? 30 : 8);
            return;
        }

        if (pnlQuote > 0) {
            this.riskPauseTicks = Math.min(this.riskPauseTicks, 4);
        }
    }

    // ── VWAP from Order Book ──
    private calculateVWAP(bids: [number, number][], asks: [number, number][]): number {
        let volumeSum = 0;
        let priceVolSum = 0;

        for (const [p, v] of bids) {
            priceVolSum += p * v;
            volumeSum += v;
        }
        for (const [p, v] of asks) {
            priceVolSum += p * v;
            volumeSum += v;
        }

        if (volumeSum === 0) return 0;
        this.vwapValue = priceVolSum / volumeSum;
        return this.vwapValue;
    }

    // ── Absorption Detection ──
    private detectAbsorption(bids: [number, number][], asks: [number, number][]): { bullish: boolean, bearish: boolean } {
        // Top-of-book wall detection
        const topBidVol = bids.slice(0, 3).reduce((s, [, v]) => s + v, 0);
        const topAskVol = asks.slice(0, 3).reduce((s, [, v]) => s + v, 0);

        // Detect if bid wall is being absorbed (bearish) or ask wall (bullish)
        const bidAbsorbed = this.lastBidWallVolume > 0 && topBidVol < this.lastBidWallVolume * 0.5;
        const askAbsorbed = this.lastAskWallVolume > 0 && topAskVol < this.lastAskWallVolume * 0.5;

        this.lastBidWallVolume = topBidVol;
        this.lastAskWallVolume = topAskVol;

        return {
            bullish: askAbsorbed,  // Ask wall eaten = buyers are aggressive = bullish
            bearish: bidAbsorbed   // Bid wall eaten = sellers are aggressive = bearish
        };
    }

    // ── Tick Velocity ──
    private getTickVelocity(price: number): number {
        if (this.lastPrice === 0) {
            this.lastPrice = price;
            return 0;
        }
        const velocity = Math.abs(price - this.lastPrice) / this.lastPrice * 100;
        this.lastPrice = price;
        return velocity;
    }

    private floorQuantity(quantity: number): number {
        if (this.exchangeStepSize > 0) {
            const precision = this.getQuantityPrecision(this.exchangeStepSize);
            const floored = Math.floor((quantity + Number.EPSILON) / this.exchangeStepSize) * this.exchangeStepSize;
            return Number(floored.toFixed(precision));
        }
        return Math.floor(quantity * 100000) / 100000;
    }

    private getEffectiveEntryMinNotional(): number {
        return Math.max(this.minNotional, this.exchangeMinNotional);
    }

    private getEffectiveExitMinNotional(): number {
        return this.exchangeMinNotional > 0 ? this.exchangeMinNotional : this.minNotional;
    }

    private getEffectiveMinQty(): number {
        return this.exchangeMinQty;
    }

    private getQuantityPrecision(stepSize: number): number {
        const step = stepSize.toString();
        const decimals = step.includes('.') ? step.split('.')[1]!.length : 0;
        return Math.min(decimals, 8);
    }

    private getDustIgnoreNotional(): number {
        return this.getEffectiveExitMinNotional() * this.dustIgnoreRatio;
    }

    private getQuoteAsset(symbol: string): string {
        const quoteAssets = ['USDC', 'USDT', 'BUSD', 'EUR'];
        return quoteAssets.find((quoteAsset) => symbol.endsWith(quoteAsset)) || 'USDC';
    }

    private isInsufficientBalanceError(exchange: Exchange, error: unknown): boolean {
        const details = exchange.getErrorDetails(error);
        const normalizedMessage = details.message.toLowerCase();
        return details.code === -2010 && normalizedMessage.includes('insufficient balance');
    }

    private async retryBuyWithFreshBalance(
        exchange: Exchange,
        symbol: string,
        desiredQuoteToSpend: number,
        executionReferencePrice: number
    ) {
        const quoteAsset = this.getQuoteAsset(symbol);
        const balances = await exchange.getBalances();
        const quoteBalance = balances.find((balance: any) => balance.asset === quoteAsset);
        const freeQuoteBalance = quoteBalance ? parseFloat(quoteBalance.free || '0') : 0;
        const spendableQuoteBalance = freeQuoteBalance * this.buyBalanceSafetyFactor;
        const minEntryNotional = this.getEffectiveEntryMinNotional() * this.entrySafetyMultiplier;
        const effectiveMinQty = this.getEffectiveMinQty();
        const retryQuoteToSpend = Math.min(spendableQuoteBalance, desiredQuoteToSpend);
        const retryQty = this.floorQuantity(retryQuoteToSpend / executionReferencePrice);
        const retryNotional = retryQty * executionReferencePrice;

        if (retryQty <= 0) {
            return null;
        }

        if (effectiveMinQty > 0 && retryQty < effectiveMinQty) {
            return null;
        }

        if (retryNotional < minEntryNotional) {
            return null;
        }

        Logger.warn(`[Pro] Retry BUY avec balance fraiche: ${retryQty} BTC pour ~${retryNotional.toFixed(2)} ${quoteAsset}`);
        return exchange.placeMarketBuy(symbol, retryQty);
    }

    private getSyncThresholdQty(): number {
        if (this.exchangeStepSize > 0) {
            return this.exchangeStepSize;
        }

        return 0.00001;
    }

    private isDustQuantity(quantity: number, price: number): boolean {
        if (quantity <= 0) return false;
        return quantity * price < this.getDustIgnoreNotional();
    }

    private isTradableQuantity(quantity: number, price: number): boolean {
        if (quantity <= 0) {
            return false;
        }

        const effectiveMinQty = this.getEffectiveMinQty();
        if (effectiveMinQty > 0 && quantity < effectiveMinQty) {
            return false;
        }

        return quantity * price >= this.getEffectiveExitMinNotional();
    }

    private armManagedPosition(entryPrice: number, quantity: number, marketPrice: number) {
        this.positionOpen = true;
        this.buyPrice = entryPrice;
        this.actualQuantity = quantity;
        this.ticksInPosition = 0;
        this.highestPriceSinceEntry = Math.max(marketPrice, entryPrice);
        this.currentTrailingPct = Math.max(this.trailingStopPct, 0.00045);
        this.trailingStopPrice = this.highestPriceSinceEntry * (1 - this.currentTrailingPct);
        this.takeProfitPrice = entryPrice * 1.0009;
        this.stopLossPrice = Math.max(entryPrice * 0.9994, this.trailingStopPrice);
        this.breakEvenTriggerPrice = entryPrice * 1.00035;
        this.breakEvenPrice = entryPrice * 1.00008;
        this.tradeConviction = 0.5;
        this.latestConviction = this.tradeConviction;
        this.exitBlockedByNotional = false;
        this.untrackedWalletPositionSeen = false;
        this.resetEntryConfirmation();
    }

    private syncTrackedPositionToWallet(price: number, walletQuantity: number, reason: string) {
        const walletQty = this.floorQuantity(walletQuantity);
        if (!this.isTradableQuantity(walletQty, price)) {
            return false;
        }

        const trackedPosition = Tracker.getOpenPosition();
        const trackedQty = trackedPosition ? this.floorQuantity(trackedPosition.quantity) : 0;
        const safeTrackedQty = Math.max(trackedQty, 0);
        const extraQty = Math.max(walletQty - safeTrackedQty, 0);
        const trackedEntryPrice = trackedPosition?.entryPrice ?? this.buyPrice;
        const blendedEntryPrice =
            safeTrackedQty > 0 && trackedEntryPrice > 0
                ? ((trackedEntryPrice * safeTrackedQty) + (price * extraQty)) / walletQty
                : price;

        this.armManagedPosition(blendedEntryPrice, walletQty, price);
        Tracker.setOpenPosition({
            entryPrice: blendedEntryPrice,
            quantity: walletQty,
        });

        Logger.warn(`[OrderBook] Position resynchronisee sur le wallet (${reason}) -> ${walletQty} BTC`);
        this.latestState = `📈 Position sync wallet @ $${blendedEntryPrice.toFixed(2)}`;
        return true;
    }

    private syncOpenPositionWithWalletIfNeeded(price: number, walletQuantity: number) {
        if (!this.positionOpen || walletQuantity <= 0) {
            return;
        }

        const walletQty = this.floorQuantity(walletQuantity);
        const trackedQty = this.floorQuantity(this.actualQuantity);
        const quantityGap = Math.abs(walletQty - trackedQty);
        if (quantityGap < this.getSyncThresholdQty()) {
            return;
        }

        if (walletQty > trackedQty && this.isTradableQuantity(walletQty, price)) {
            this.actualQuantity = walletQty;
            const trackedPosition = Tracker.getOpenPosition();
            const syncedEntryPrice = trackedPosition?.entryPrice ?? this.buyPrice ?? price;
            if (trackedPosition || syncedEntryPrice > 0) {
                Tracker.setOpenPosition({
                    entryPrice: syncedEntryPrice,
                    quantity: walletQty,
                });
            }
            Logger.warn(`[OrderBook] Quantite suivie augmentee pour coller au wallet -> ${walletQty} BTC`);
            return;
        }

        if (walletQty < trackedQty && walletQty > 0) {
            this.actualQuantity = walletQty;
            const trackedPosition = Tracker.getOpenPosition();
            if (trackedPosition) {
                Tracker.setOpenPosition({
                    entryPrice: trackedPosition.entryPrice,
                    quantity: walletQty,
                });
            }
            Logger.warn(`[OrderBook] Quantite suivie reduite pour coller au wallet -> ${walletQty} BTC`);
        }
    }

    private clearTrackedDustIfNeeded(price: number) {
        const trackedPosition = Tracker.getOpenPosition();
        if (!trackedPosition) return;

        if (this.isDustQuantity(trackedPosition.quantity, price)) {
            Tracker.setOpenPosition(null);
        }
    }

    private ignoreDustPosition(reason: string, price: number, walletQuantity: number) {
        const dustNotional = walletQuantity * price;
        Logger.info(`[OrderBook] Dust ignoree (${reason}) ~ $${dustNotional.toFixed(2)}. Strategie rearmee.`);
        this.resetPositionState();
        this.clearTrackedDustIfNeeded(price);
        this.latestState = `🧹 Dust ignoree ($${dustNotional.toFixed(2)})`;
    }

    private resetPositionState() {
        this.positionOpen = false;
        this.buyPrice = 0;
        this.actualQuantity = 0;
        this.ticksInPosition = 0;
        this.takeProfitPrice = 0;
        this.stopLossPrice = 0;
        this.trailingStopPrice = 0;
        this.highestPriceSinceEntry = 0;
        this.exitBlockedByNotional = false;
        this.currentTrailingPct = this.trailingStopPct;
        this.breakEvenArmed = false;
        this.breakEvenTriggerPrice = 0;
        this.breakEvenPrice = 0;
        this.tradeConviction = 0;
        this.latestConviction = 0;
        this.tpExtensionsUsed = 0;
        this.resetEntryConfirmation();
    }

    private async ensureExchangeRules(exchange: Exchange, symbol: string) {
        if (this.exchangeRulesLoadedSymbol === symbol) {
            return;
        }

        try {
            const rules = await exchange.getSymbolTradingRules(symbol);
            if (rules.minNotional > 0) {
                this.exchangeMinNotional = rules.minNotional;
            }
            if (rules.minQty > 0) {
                this.exchangeMinQty = rules.minQty;
            }
            if (rules.stepSize > 0) {
                this.exchangeStepSize = rules.stepSize;
            }
            this.exchangeRulesLoadedSymbol = symbol;
        } catch (error) {
            if (this.exchangeRulesLoadedSymbol !== symbol) {
                Logger.warn(`[OrderBook] Impossible de charger les filtres Binance pour ${symbol}, fallback local a $${this.minNotional.toFixed(2)}`);
                this.exchangeRulesLoadedSymbol = symbol;
            }
        }
    }

    private blockExitBecauseExchangeFilters(price: number, sellQty: number, reason: string) {
        const sellNotional = sellQty * price;
        const minExitNotional = this.getEffectiveExitMinNotional() * this.exitSafetyMultiplier;
        const effectiveMinQty = this.getEffectiveMinQty();
        if (!this.exitBlockedByNotional) {
            const qtyHint = effectiveMinQty > 0 && sellQty < effectiveMinQty
                ? ` ou qty ${sellQty} < ${effectiveMinQty}`
                : '';
            Logger.warn(`[Pro] ${reason} ignore: notional ${sellNotional.toFixed(2)} < ${minExitNotional.toFixed(2)}${qtyHint} pour sortir`);
            this.exitBlockedByNotional = true;
        }
        this.latestState = `⚠️ Sortie bloquee (${sellNotional.toFixed(2)} < ${minExitNotional.toFixed(2)})`;
    }

    private restoreTrackedPosition(price: number, walletQuantity: number): boolean {
        const trackedPosition = Tracker.getOpenPosition();
        const walletQty = this.floorQuantity(walletQuantity);
        const walletTradable = this.isTradableQuantity(walletQty, price);

        if (!walletTradable) {
            return false;
        }

        if (!trackedPosition) {
            if (!this.untrackedWalletPositionSeen) {
                Logger.warn(`[OrderBook] BTC detecte sans position suivie dans le tracker: ${walletQty} BTC. Adoption du wallet.`);
                this.untrackedWalletPositionSeen = true;
            }
            return this.syncTrackedPositionToWallet(price, walletQty, "tracker absent");
        }

        const trackedQty = this.floorQuantity(trackedPosition.quantity);
        const quantityGap = Math.abs(walletQty - trackedQty);
        if (walletQty > trackedQty && quantityGap >= this.getSyncThresholdQty()) {
            return this.syncTrackedPositionToWallet(price, walletQty, `wallet ${walletQty} > tracker ${trackedQty}`);
        }

        const restoredQty = walletQty > 0 ? Math.min(walletQty, trackedQty) : trackedQty;
        const restoredNotional = restoredQty * price;
        if (
            restoredQty <= 0 ||
            (this.getEffectiveMinQty() > 0 && restoredQty < this.getEffectiveMinQty()) ||
            restoredNotional < this.getEffectiveExitMinNotional()
        ) {
            return false;
        }

        this.armManagedPosition(trackedPosition.entryPrice, restoredQty, price);

        if (restoredQty !== trackedQty) {
            Tracker.setOpenPosition({ entryPrice: trackedPosition.entryPrice, quantity: restoredQty });
        }

        Logger.info(`[OrderBook] Position restauree: ${this.actualQuantity} BTC @ $${this.buyPrice.toFixed(2)}`);
        this.latestState = `📈 Position restauree @ $${this.buyPrice.toFixed(2)}`;
        return true;
    }

    private getSellQuantity(walletQuantity: number): number {
        const walletQty = this.floorQuantity(walletQuantity);
        const trackedQty = this.floorQuantity(this.actualQuantity);

        if (trackedQty > 0 && walletQty === 0) {
            return trackedQty;
        }
        if (trackedQty > 0 && walletQty > 0) {
            return Math.min(trackedQty, walletQty);
        }
        return walletQty;
    }

    async onTick(price: number, exchange: Exchange, symbol: string, ctx: TickContext): Promise<void> {
        // ── Update all indicators ──
        this.updateEMA(price);
        const atrPct = this.updateATR(price);
        const tickVelocity = this.getTickVelocity(price);

        await this.ensureExchangeRules(exchange, symbol);
        this.refreshDailyRiskState();

        // Cooldown
        if (this.cooldownTicks > 0) {
            this.cooldownTicks--;
            this.latestState = `⏸️ Cooldown (${this.cooldownTicks}s) | ATR: ${atrPct.toFixed(4)}%`;
            return;
        }

        if (!this.positionOpen && this.dailyRealizedPnl <= -this.dailyLossLimitQuote) {
            this.resetEntryConfirmation();
            this.marketRegime = 'HALTED';
            this.latestRegime = this.marketRegime;
            this.latestState = `🛑 Daily stop ${this.dailyRealizedPnl.toFixed(2)}$ | reset demain`;
            return;
        }

        if (!this.positionOpen && this.riskPauseTicks > 0) {
            this.resetEntryConfirmation();
            this.riskPauseTicks--;
            this.latestState = `🧯 Risk pause (${this.riskPauseTicks}) | Daily:${this.dailyRealizedPnl.toFixed(2)}$`;
            return;
        }

        if (!this.positionOpen && ctx.balanceBTC <= 0 && Tracker.getOpenPosition()) {
            Logger.warn("[OrderBook] Position tracker nettoyee car aucun BTC n'est disponible dans le wallet");
            Tracker.setOpenPosition(null);
        }

        if (!this.positionOpen && ctx.balanceBTC > 0 && this.isDustQuantity(ctx.balanceBTC, price)) {
            this.clearTrackedDustIfNeeded(price);
        }

        // ── Restore a tracked position on boot ──
        if (!this.positionOpen && ctx.balanceBTC > 0) {
            if (this.restoreTrackedPosition(price, ctx.balanceBTC)) {
                return;
            }
        }

        // ── Use WebSocket-fed order book (no REST call needed) ──
        const bids = ctx.bids;
        const asks = ctx.asks;
        if (bids.length === 0 || asks.length === 0) {
            this.resetEntryConfirmation();
            this.latestState = "⚠️ Carnet d'ordres vide (WS)";
            return;
        }

        // ── Compute Indicators ──
        const totalBidVol = bids.reduce((sum, [, qty]) => sum + qty, 0);
        const totalAskVol = asks.reduce((sum, [, qty]) => sum + qty, 0);
        const obi = totalBidVol / Math.max(totalBidVol + totalAskVol, Number.EPSILON);
        const topBidVol = bids.slice(0, 5).reduce((sum, [, qty]) => sum + qty, 0);
        const topAskVol = asks.slice(0, 5).reduce((sum, [, qty]) => sum + qty, 0);
        const topObi = topBidVol / Math.max(topBidVol + topAskVol, Number.EPSILON);

        const bestBid = bids[0]![0];
        const bestBidQty = bids[0]![1];
        const bestAsk = asks[0]![0];
        const bestAskQty = asks[0]![1];
        const spreadAbs = bestAsk - bestBid;
        const spreadPct = (spreadAbs / price) * 100;
        this.latestSpread = spreadPct;
        const midPrice = (bestBid + bestAsk) / 2;
        const microPrice = (bestAsk * bestBidQty + bestBid * bestAskQty) / Math.max(bestBidQty + bestAskQty, Number.EPSILON);
        const microPriceEdgePct = ((microPrice - midPrice) / midPrice) * 100;
        const depthRatio = bestBidQty / Math.max(bestAskQty, Number.EPSILON);
        const nearDepthShare = (topBidVol + topAskVol) / Math.max(totalBidVol + totalAskVol, Number.EPSILON);
        const emaGapPct = ((this.emaFast - this.emaSlow) / price) * 100;

        const vwap = this.calculateVWAP(bids, asks);
        const absorption = this.detectAbsorption(bids, asks);
        const smoothedBookState = this.updateSmoothedBookState(
            obi,
            topObi,
            spreadPct,
            microPriceEdgePct,
            depthRatio,
            nearDepthShare,
            bestBidQty,
            bestAskQty,
            absorption
        );
        const regimeAssessment = this.assessMarketRegime(atrPct, emaGapPct, smoothedBookState);
        this.marketRegime = regimeAssessment.regime;
        this.latestRegime = regimeAssessment.regime;
        this.latestOBI = smoothedBookState.smoothedObi;
        this.latestSpread = smoothedBookState.smoothedSpreadPct;

        // ══════════════════════════════════════════════════
        // ──────────── ENTRY LOGIC ────────────
        // ══════════════════════════════════════════════════
        if (!this.positionOpen) {
            const effectiveMinNotional = this.getEffectiveEntryMinNotional();
            const spendableQuoteBalance = ctx.balanceQuote * this.buyBalanceSafetyFactor;

            // Balance check
            if (spendableQuoteBalance < effectiveMinNotional) {
                this.resetEntryConfirmation();
                this.latestState = `💤 USDC dispo: $${spendableQuoteBalance.toFixed(2)} < $${effectiveMinNotional.toFixed(2)}`;
                return;
            }

            if (!regimeAssessment.allowEntries) {
                this.resetEntryConfirmation();
                this.latestState = `🧭 ${regimeAssessment.regime} | ${regimeAssessment.note}`;
                return;
            }

            // ── Filter 1: Anti-Chop (ATR) ──
            const atrOk = atrPct > this.minAtrPct;

            // ── Filter 2: Tick Velocity (no spikes) ──
            const velocityOk = tickVelocity < this.maxTickVelocityPct;

            // ── Filter 3: OBI ──
            const obiOk = smoothedBookState.smoothedObi > this.obiThreshold;

            // ── Filter 4: Top-of-book OBI ──
            const topObiOk = smoothedBookState.smoothedTopObi > this.topObiEntryThreshold;

            // ── Filter 5: Spread ──
            const spreadOk = smoothedBookState.smoothedSpreadPct < this.maxSpreadPct;

            // ── Filter 6: Dual EMA Crossover ──
            const emaCrossOk = this.emaFast > this.emaSlow;
            const trendStrengthOk = emaGapPct > Math.max(smoothedBookState.smoothedSpreadPct * 0.35, 0.0025);

            // ── Filter 7: VWAP ──
            const vwapOk = price <= vwap * 1.0001; // Buy at or below VWAP (discount)

            // ── Filter 8: Microprice & best-bid dominance, lisses ──
            const microPriceOk = smoothedBookState.smoothedMicroPriceEdgePct > 0;
            const depthRatioOk = smoothedBookState.smoothedDepthRatio > this.depthRatioEntryThreshold;
            const persistenceOk =
                smoothedBookState.obiSlope >= -0.001 &&
                smoothedBookState.topObiSlope >= -0.0015 &&
                smoothedBookState.smoothedAskConsumption > this.persistenceAskConsumptionThreshold;

            // ── Bonus: Absorption signal ──
            const absorptionBoost = absorption.bullish || smoothedBookState.smoothedAbsorptionBias > this.absorptionBiasThreshold; // Ask wall eating = strong buy

            // Score system: each filter adds points, trade when score >= threshold
            let score = 0;
            const scoreReasons: string[] = [];

            if (obiOk) { score += 2; } else { scoreReasons.push(`OBI:${(smoothedBookState.smoothedObi * 100).toFixed(0)}%`); }
            if (topObiOk) { score += 2; } else { scoreReasons.push(`TopOBI:${(smoothedBookState.smoothedTopObi * 100).toFixed(0)}%`); }
            if (spreadOk) { score += 1; } else { scoreReasons.push(`Sprd:${smoothedBookState.smoothedSpreadPct.toFixed(3)}%`); }
            if (emaCrossOk) { score += 1; } else { scoreReasons.push('EMA↓'); }
            if (trendStrengthOk) { score += 1; } else { scoreReasons.push(`Trend:${emaGapPct.toFixed(3)}%`); }
            if (vwapOk) { score += 1; } else { scoreReasons.push('VWAP↑'); }
            if (microPriceOk) { score += 1; } else { scoreReasons.push(`Micro:${smoothedBookState.smoothedMicroPriceEdgePct.toFixed(4)}%`); }
            if (depthRatioOk) { score += 1; } else { scoreReasons.push(`Depth:${smoothedBookState.smoothedDepthRatio.toFixed(2)}`); }
            if (atrOk) { score += 1; } else { scoreReasons.push('Chop'); }
            if (velocityOk) { score += 1; } else { scoreReasons.push('Spike'); }
            if (persistenceOk) { score += 1; } else { scoreReasons.push('Persist'); }
            if (absorptionBoost) { score += 1; scoreReasons.push('🔥Absorb!'); }

            const minScore = this.minScore + regimeAssessment.minScoreAdjustment + (this.consecutiveLosses >= 2 ? 1 : 0);
            const maxScore = 14;

            if (score < minScore) {
                this.resetEntryConfirmation();
                this.latestState = `🔍 ${regimeAssessment.regime} ${score}/${minScore} | ${scoreReasons.join(' ')}`;
                return;
            }

            if (!this.advanceEntryConfirmation(price, regimeAssessment.regime)) {
                this.latestState = `🧪 Confirm ${this.entryConfirmationCount}/${this.entryConfirmationTicksRequired} | ${regimeAssessment.regime} ${score}/${minScore}`;
                return;
            }

            const conviction = Math.min(Math.max((score - minScore) / Math.max(maxScore - minScore, 1), 0), 1);
            this.tradeConviction = conviction;
            this.latestConviction = conviction;

            // ── Position Sizing ──
            const minEntryNotional = effectiveMinNotional * this.entrySafetyMultiplier;
            const lossPenalty = Math.min(this.consecutiveLosses * this.lossPenaltyPerStreak, 0.20);
            const dailyPenalty = this.dailyRealizedPnl < 0
                ? Math.min(Math.abs(this.dailyRealizedPnl) / Math.max(this.dailyLossLimitQuote, Number.EPSILON) * 0.22, 0.22)
                : 0;
            const rawAllocation = (this.baseRiskAllocation + conviction * this.scoreRiskBonus - lossPenalty - dailyPenalty) * regimeAssessment.riskMultiplier;
            const allocation = Math.min(Math.max(rawAllocation, this.minRiskAllocation), this.maxRiskAllocation);
            const dynamicCap = Math.max(minEntryNotional, this.maxPositionNotional * regimeAssessment.riskMultiplier * (0.78 + conviction * 0.22));
            const allocationQuote = spendableQuoteBalance * allocation;
            const quoteToSpend = Math.min(spendableQuoteBalance, Math.max(minEntryNotional, Math.min(allocationQuote, dynamicCap)));
            const executionReferencePrice = Math.max(price, bestAsk) * this.buyPriceSafetyMultiplier;
            let qty = quoteToSpend / executionReferencePrice;
            qty = this.floorQuantity(qty);
            const estimatedEntryNotional = qty * executionReferencePrice;
            const effectiveMinQty = this.getEffectiveMinQty();
            const entryCosts = this.estimateExecutionCosts(
                estimatedEntryNotional,
                conviction,
                Math.max(smoothedBookState.smoothedSpreadPct / Math.max(this.maxSpreadPct, Number.EPSILON) - 0.5, 0)
            );
            const entryReason = `${regimeAssessment.regime.toLowerCase()}_entry`;

            if (qty <= 0) {
                this.resetEntryConfirmation();
                this.latestState = "⚠️ Qty trop faible";
                return;
            }

            if (effectiveMinQty > 0 && qty < effectiveMinQty) {
                this.resetEntryConfirmation();
                this.latestState = `⚠️ Qty ${qty} < minQty ${effectiveMinQty}`;
                return;
            }

            if (estimatedEntryNotional < minEntryNotional) {
                this.resetEntryConfirmation();
                this.latestState = `💤 Notional reel trop faible: $${estimatedEntryNotional.toFixed(2)} < $${minEntryNotional.toFixed(2)}`;
                return;
            }

            // ── Dynamic TP/SL scaled by volatility and conviction ──
            const atrAbs = price * (atrPct / 100);
            const volatilityUnit = Math.max(spreadAbs * 2, atrAbs * 0.8, price * 0.00012);
            const tpDistance = volatilityUnit * this.tpMultiplier * (1 + conviction * 0.30);
            const slDistance = volatilityUnit * this.slMultiplier * Math.max(0.85, 1 - conviction * 0.12);
            this.takeProfitPrice = price + tpDistance;
            this.stopLossPrice = price - slDistance;
            this.currentTrailingPct = Math.min(Math.max((atrPct / 100) * (1.1 + conviction * 0.4), 0.00035), 0.0012);
            this.trailingStopPrice = price * (1 - this.currentTrailingPct);
            this.highestPriceSinceEntry = price;
            this.breakEvenArmed = false;
            this.breakEvenTriggerPrice = price + tpDistance * 0.45;
            this.breakEvenPrice = price + Math.max(spreadAbs * 0.5, price * 0.00006);
            this.tpExtensionsUsed = 0;

            Logger.success(`📊 [Pro] ENTRY! Regime:${regimeAssessment.regime} Score:${score} Conv:${(conviction * 100).toFixed(0)}% OBI:${(smoothedBookState.smoothedObi * 100).toFixed(0)}% Top:${(smoothedBookState.smoothedTopObi * 100).toFixed(0)}% EMA:${this.emaFast.toFixed(0)}/${this.emaSlow.toFixed(0)} ATR:${atrPct.toFixed(4)}%`);
            Logger.info(`[Pro] TP:$${this.takeProfitPrice.toFixed(2)} SL:$${this.stopLossPrice.toFixed(2)} Trail:${(this.currentTrailingPct * 100).toFixed(3)}% Qty:${qty} EstCost:$${estimatedEntryNotional.toFixed(2)} Alloc:${(allocation * 100).toFixed(1)}%`);

            try {
                const result = await exchange.placeMarketBuy(symbol, qty);
                this.positionOpen = true;
                this.buyPrice = price;
                this.actualQuantity = result.actualQuantity;
                this.ticksInPosition = 0;
                this.untrackedWalletPositionSeen = false;
                this.exitBlockedByNotional = false;
                this.resetEntryConfirmation();
                this.latestState = `📈 ${regimeAssessment.regime} Long @ $${price.toFixed(2)} | Score:${score}`;
                Tracker.addTrade('BUY', price, this.actualQuantity, {
                    reason: entryReason,
                    marketRegime: regimeAssessment.regime,
                    conviction,
                    estimatedFeesQuote: entryCosts.feesQuote,
                    estimatedSlippageQuote: entryCosts.slippageQuote,
                });
            } catch (e) {
                if (this.isInsufficientBalanceError(exchange, e)) {
                    try {
                        const retryResult = await this.retryBuyWithFreshBalance(
                            exchange,
                            symbol,
                            quoteToSpend,
                            executionReferencePrice
                        );

                        if (retryResult) {
                            this.positionOpen = true;
                            this.buyPrice = price;
                            this.actualQuantity = retryResult.actualQuantity;
                            this.ticksInPosition = 0;
                            this.untrackedWalletPositionSeen = false;
                            this.exitBlockedByNotional = false;
                            this.resetEntryConfirmation();
                            this.latestState = `📈 ${regimeAssessment.regime} Long @ $${price.toFixed(2)} | Retry`;
                            Tracker.addTrade('BUY', price, this.actualQuantity, {
                                reason: `${entryReason}_retry`,
                                marketRegime: regimeAssessment.regime,
                                conviction,
                                estimatedFeesQuote: entryCosts.feesQuote,
                                estimatedSlippageQuote: entryCosts.slippageQuote,
                            });
                            return;
                        }
                    } catch (retryError) {
                        Logger.error("Pro BUY retry échoué");
                    }
                }
                Logger.error("Pro BUY échoué");
                this.resetEntryConfirmation();
                this.latestState = "❌ Buy failed";
                this.cooldownTicks = 5;
            }
        } else {
            // ══════════════════════════════════════════════════
            // ──────────── EXIT LOGIC ────────────
            // ══════════════════════════════════════════════════

            this.syncOpenPositionWithWalletIfNeeded(price, ctx.balanceBTC);

            if (ctx.balanceBTC > 0 && this.isDustQuantity(ctx.balanceBTC, price)) {
                this.ignoreDustPosition("wallet sous le seuil de vente", price, ctx.balanceBTC);
                return;
            }

            this.ticksInPosition++;

            if (!this.breakEvenArmed && price >= this.breakEvenTriggerPrice) {
                this.breakEvenArmed = true;
                this.stopLossPrice = Math.max(this.stopLossPrice, this.breakEvenPrice);
            }

            // ── Update Trailing Stop ──
            if (price > this.highestPriceSinceEntry) {
                this.highestPriceSinceEntry = price;
                const newTrailing = price * (1 - this.currentTrailingPct);
                if (newTrailing > this.trailingStopPrice) {
                    this.trailingStopPrice = newTrailing;
                }
                // Also raise SL if trailing is higher
                if (this.trailingStopPrice > this.stopLossPrice) {
                    this.stopLossPrice = this.trailingStopPrice;
                }
            }

            const sellQty = this.getSellQuantity(ctx.balanceBTC);
            const minExitNotional = this.getEffectiveExitMinNotional() * this.exitSafetyMultiplier;
            const effectiveMinQty = this.getEffectiveMinQty();
            const canSendSellOrder = sellQty * price >= minExitNotional && (effectiveMinQty <= 0 || sellQty >= effectiveMinQty);
            if (sellQty <= 0) {
                Logger.warn("[Pro] Quantite vendable nulle, reset de l'etat local");
                this.resetPositionState();
                Tracker.setOpenPosition(null);
                this.latestState = "⚠️ Position introuvable, etat reinitialise";
                return;
            }
            if (canSendSellOrder) {
                this.exitBlockedByNotional = false;
            }

            const unrealizedPnlPct = this.buyPrice > 0
                ? ((price - this.buyPrice) / this.buyPrice) * 100
                : 0;

            const strongTrendContinuation =
                this.tpExtensionsUsed < this.maxTpExtensions &&
                price >= this.takeProfitPrice &&
                smoothedBookState.smoothedObi > Math.max(this.obiThreshold + 0.04, 0.63) &&
                smoothedBookState.smoothedTopObi > Math.max(this.topObiEntryThreshold + 0.03, 0.59) &&
                this.emaFast > this.emaSlow &&
                smoothedBookState.smoothedMicroPriceEdgePct > 0 &&
                tickVelocity < this.maxTickVelocityPct * 0.8;

            if (strongTrendContinuation) {
                const extensionDistance = Math.max((this.takeProfitPrice - this.buyPrice) * (0.30 + this.tradeConviction * 0.20), price * 0.00025);
                this.takeProfitPrice = price + extensionDistance;
                this.currentTrailingPct = Math.max(0.00025, this.currentTrailingPct * 0.75);
                this.tpExtensionsUsed++;
                this.latestState = `🚀 Winner extend | TP:$${this.takeProfitPrice.toFixed(2)}`;
                Logger.info(`[Pro] TP extension activee: nouveau TP $${this.takeProfitPrice.toFixed(2)} | Trail ${(this.currentTrailingPct * 100).toFixed(3)}%`);
                return;
            }

            // 1. Take-Profit
            if (price >= this.takeProfitPrice) {
                if (!canSendSellOrder) {
                    this.blockExitBecauseExchangeFilters(price, sellQty, "Take-profit");
                    return;
                }
                Logger.success(`🚀 [Pro] Take-Profit! $${price.toFixed(2)} ≥ $${this.takeProfitPrice.toFixed(2)}`);
                try {
                    const grossPnlQuote = (price - this.buyPrice) * sellQty;
                    const exitCosts = this.estimateExecutionCosts(sellQty * price, this.tradeConviction, smoothedBookState.smoothedSpreadPct / Math.max(this.maxSpreadPct, Number.EPSILON));
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    this.cooldownTicks = 3;
                    this.consecutiveLosses = 0;
                    this.latestState = "✅ Profit encaissé!";
                    this.recordClosedTradeOutcome(grossPnlQuote, 'take_profit');
                    Tracker.addTrade('SELL', price, sellQty, {
                        reason: 'take_profit',
                        marketRegime: this.marketRegime,
                        conviction: this.tradeConviction,
                        estimatedFeesQuote: exitCosts.feesQuote,
                        estimatedSlippageQuote: exitCosts.slippageQuote,
                    });
                } catch (e) { Logger.error("Pro SELL (TP) échoué"); }
                return;
            }

            // 2. Trailing Stop / Stop-Loss
            if (price <= this.stopLossPrice) {
                const wasProfit = price > this.buyPrice;
                if (!canSendSellOrder) {
                    this.blockExitBecauseExchangeFilters(price, sellQty, wasProfit ? "Trailing stop" : "Stop-loss");
                    return;
                }
                if (wasProfit) {
                    Logger.success(`📈 [Pro] Trailing Stop (profit lock)! $${price.toFixed(2)}`);
                } else {
                    Logger.warn(`🛑 [Pro] Stop-Loss! $${price.toFixed(2)} ≤ $${this.stopLossPrice.toFixed(2)}`);
                    this.consecutiveLosses++;
                }
                try {
                    const grossPnlQuote = (price - this.buyPrice) * sellQty;
                    const exitCosts = this.estimateExecutionCosts(sellQty * price, this.tradeConviction, smoothedBookState.smoothedBidConsumption + smoothedBookState.smoothedSpreadPct / Math.max(this.maxSpreadPct, Number.EPSILON));
                    const exitReason = wasProfit ? 'trailing_profit' : 'stop_loss';
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    // Longer cooldown after loss streak
                    this.cooldownTicks = this.consecutiveLosses >= this.maxConsecutiveLosses ? 15 : 5;
                    this.latestState = wasProfit ? "📈 Trailing profit!" : `🛡️ SL (streak: ${this.consecutiveLosses})`;
                    this.recordClosedTradeOutcome(grossPnlQuote, exitReason);
                    Tracker.addTrade('SELL', price, sellQty, {
                        reason: exitReason,
                        marketRegime: this.marketRegime,
                        conviction: this.tradeConviction,
                        estimatedFeesQuote: exitCosts.feesQuote,
                        estimatedSlippageQuote: exitCosts.slippageQuote,
                    });
                } catch (e) { Logger.error("Pro SELL (SL) échoué"); }
                return;
            }

            // 3. Time / stagnation exit
            const stagnatingTrade =
                this.ticksInPosition >= this.stagnationTicks &&
                unrealizedPnlPct < this.stagnationMaxPnlPct &&
                smoothedBookState.smoothedObi < this.stagnationObiThreshold &&
                smoothedBookState.smoothedMicroPriceEdgePct <= 0 &&
                this.highestPriceSinceEntry < this.buyPrice * (1 + (this.stagnationMaxPnlPct * 1.4) / 100);

            if (stagnatingTrade) {
                if (!canSendSellOrder) {
                    this.blockExitBecauseExchangeFilters(price, sellQty, "Stagnation exit");
                    return;
                }
                Logger.warn(`⌛ [Pro] Stagnation exit @ $${price.toFixed(2)} | hold:${this.ticksInPosition} ticks | PnL:${unrealizedPnlPct.toFixed(3)}%`);
                try {
                    const grossPnlQuote = (price - this.buyPrice) * sellQty;
                    const exitCosts = this.estimateExecutionCosts(
                        sellQty * price,
                        this.tradeConviction,
                        smoothedBookState.smoothedBidConsumption + smoothedBookState.smoothedSpreadPct / Math.max(this.maxSpreadPct, Number.EPSILON)
                    );
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    this.cooldownTicks = 6;
                    if (grossPnlQuote <= 0) {
                        this.consecutiveLosses++;
                    } else {
                        this.consecutiveLosses = 0;
                    }
                    this.latestState = "⌛ Stagnation Exit";
                    this.recordClosedTradeOutcome(grossPnlQuote, 'stagnation_exit');
                    Tracker.addTrade('SELL', price, sellQty, {
                        reason: 'stagnation_exit',
                        marketRegime: this.marketRegime,
                        conviction: this.tradeConviction,
                        estimatedFeesQuote: exitCosts.feesQuote,
                        estimatedSlippageQuote: exitCosts.slippageQuote,
                    });
                } catch (e) { Logger.error("Pro SELL (Stagnation) échoué"); }
                return;
            }

            // 4. OBI Reversal Exit
            if ((smoothedBookState.smoothedObi < this.obiExitThreshold && this.emaFast <= this.emaSlow) || this.marketRegime === 'HOSTILE') {
                if (!canSendSellOrder) {
                    this.blockExitBecauseExchangeFilters(price, sellQty, "OBI reversal");
                    return;
                }
                const exitReason = this.marketRegime === 'HOSTILE' ? 'hostile_regime_exit' : 'obi_reversal';
                Logger.warn(`⚡ [Pro] OBI Reversal (${(smoothedBookState.smoothedObi * 100).toFixed(1)}%) @ $${price.toFixed(2)}`);
                try {
                    const wasProfit = price > this.buyPrice;
                    const grossPnlQuote = (price - this.buyPrice) * sellQty;
                    const exitCosts = this.estimateExecutionCosts(sellQty * price, this.tradeConviction, smoothedBookState.smoothedBidConsumption);
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    this.cooldownTicks = 4;
                    if (!wasProfit) this.consecutiveLosses++;
                    else this.consecutiveLosses = 0;
                    this.latestState = "⚡ OBI Exit";
                    this.recordClosedTradeOutcome(grossPnlQuote, exitReason);
                    Tracker.addTrade('SELL', price, sellQty, {
                        reason: exitReason,
                        marketRegime: this.marketRegime,
                        conviction: this.tradeConviction,
                        estimatedFeesQuote: exitCosts.feesQuote,
                        estimatedSlippageQuote: exitCosts.slippageQuote,
                    });
                } catch (e) { Logger.error("Pro SELL (OBI) échoué"); }
                return;
            }

            // 5. Bearish Absorption while holding → early exit
            if ((absorption.bearish || smoothedBookState.smoothedAbsorptionBias < -this.absorptionBiasThreshold) && price < this.buyPrice) {
                if (!canSendSellOrder) {
                    this.blockExitBecauseExchangeFilters(price, sellQty, "Emergency exit");
                    return;
                }
                Logger.warn(`🔥 [Pro] Bid Wall absorbed! Emergency exit @ $${price.toFixed(2)}`);
                try {
                    const grossPnlQuote = (price - this.buyPrice) * sellQty;
                    const exitCosts = this.estimateExecutionCosts(sellQty * price, this.tradeConviction, smoothedBookState.smoothedBidConsumption + 0.4);
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    this.cooldownTicks = 5;
                    this.consecutiveLosses++;
                    this.latestState = "🔥 Absorption Exit";
                    this.recordClosedTradeOutcome(grossPnlQuote, 'absorption_exit');
                    Tracker.addTrade('SELL', price, sellQty, {
                        reason: 'absorption_exit',
                        marketRegime: this.marketRegime,
                        conviction: this.tradeConviction,
                        estimatedFeesQuote: exitCosts.feesQuote,
                        estimatedSlippageQuote: exitCosts.slippageQuote,
                    });
                } catch (e) { Logger.error("Pro SELL (Absorb) échoué"); }
                return;
            }

            // ── Still holding ──
            const pnl = ((price - this.buyPrice) / this.buyPrice * 100).toFixed(3);
            this.latestState = `📈 ${this.marketRegime} | $${this.buyPrice.toFixed(0)} | PnL:${pnl}% | TP:$${this.takeProfitPrice.toFixed(0)} | SL:$${this.stopLossPrice.toFixed(0)} | OBI:${(smoothedBookState.smoothedObi * 100).toFixed(0)}%`;
        }
    }
}
