import type { ITradingStrategy, TickContext } from "./index";
import { Exchange } from "../core/exchange";
import { Logger } from "../utils/logger";
import { Tracker } from "../core/tracker";

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
    private maxPositionNotional: number = 35;
    private baseRiskAllocation: number = 0.45;
    private scoreRiskBonus: number = 0.35;
    private lossPenaltyPerStreak: number = 0.08;
    private dustIgnoreRatio: number = 0.35;

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

    // ── Config ──
    private maxSpreadPct: number;
    private obiThreshold: number;
    private obiExitThreshold: number;
    private tpMultiplier: number;
    private slMultiplier: number;
    private minNotional: number;

    constructor(
        maxSpreadPct: number = 0.05,
        obiThreshold: number = 0.58,
        obiExitThreshold: number = 0.38,
        tpMultiplier: number = 4.2,
        slMultiplier: number = 2.2,
        minNotional: number = 6.0
    ) {
        this.maxSpreadPct = maxSpreadPct;
        this.obiThreshold = obiThreshold;
        this.obiExitThreshold = obiExitThreshold;
        this.tpMultiplier = tpMultiplier;
        this.slMultiplier = slMultiplier;
        this.minNotional = minNotional;
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

    private getEffectiveMinNotional(): number {
        return Math.max(this.minNotional, this.exchangeMinNotional);
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
        return this.getEffectiveMinNotional() * this.dustIgnoreRatio;
    }

    private isDustQuantity(quantity: number, price: number): boolean {
        if (quantity <= 0) return false;
        return quantity * price < this.getDustIgnoreNotional();
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
        const minExitNotional = this.getEffectiveMinNotional() * this.exitSafetyMultiplier;
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
        const walletValue = walletQty * price;
        const effectiveMinNotional = this.getEffectiveMinNotional();

        if (walletValue < effectiveMinNotional) {
            return false;
        }

        if (!trackedPosition) {
            if (!this.untrackedWalletPositionSeen) {
                Logger.warn(`[OrderBook] BTC detecte sans position suivie dans le tracker: ${walletQty} BTC`);
                this.untrackedWalletPositionSeen = true;
            }
            this.latestState = `⚠️ BTC detecte (${walletQty}) sans entree suivie`;
            return true;
        }

        const trackedQty = this.floorQuantity(trackedPosition.quantity);
        const restoredQty = walletQty > 0 ? Math.min(walletQty, trackedQty) : trackedQty;
        const restoredNotional = restoredQty * price;
        if (
            restoredQty <= 0 ||
            (this.getEffectiveMinQty() > 0 && restoredQty < this.getEffectiveMinQty()) ||
            restoredNotional < this.getEffectiveMinNotional()
        ) {
            return false;
        }

        this.positionOpen = true;
        this.buyPrice = trackedPosition.entryPrice;
        this.actualQuantity = restoredQty;
        this.highestPriceSinceEntry = Math.max(price, this.buyPrice);
        this.currentTrailingPct = Math.max(this.trailingStopPct, 0.00045);
        this.trailingStopPrice = this.highestPriceSinceEntry * (1 - this.currentTrailingPct);
        this.takeProfitPrice = this.buyPrice * 1.0009;
        this.stopLossPrice = Math.max(this.buyPrice * 0.9994, this.trailingStopPrice);
        this.breakEvenTriggerPrice = this.buyPrice * 1.00035;
        this.breakEvenPrice = this.buyPrice * 1.00008;
        this.tradeConviction = 0.5;
        this.latestConviction = this.tradeConviction;
        this.untrackedWalletPositionSeen = false;

        if (restoredQty !== trackedQty) {
            Tracker.setOpenPosition({ entryPrice: this.buyPrice, quantity: restoredQty });
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

        // Cooldown
        if (this.cooldownTicks > 0) {
            this.cooldownTicks--;
            this.latestState = `⏸️ Cooldown (${this.cooldownTicks}s) | ATR: ${atrPct.toFixed(4)}%`;
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
            this.latestState = "⚠️ Carnet d'ordres vide (WS)";
            return;
        }

        // ── Compute Indicators ──
        const totalBidVol = bids.reduce((sum, [, qty]) => sum + qty, 0);
        const totalAskVol = asks.reduce((sum, [, qty]) => sum + qty, 0);
        const obi = totalBidVol / Math.max(totalBidVol + totalAskVol, Number.EPSILON);
        this.latestOBI = obi;
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
        const emaGapPct = ((this.emaFast - this.emaSlow) / price) * 100;

        const vwap = this.calculateVWAP(bids, asks);
        const absorption = this.detectAbsorption(bids, asks);

        // ══════════════════════════════════════════════════
        // ──────────── ENTRY LOGIC ────────────
        // ══════════════════════════════════════════════════
        if (!this.positionOpen) {
            const effectiveMinNotional = this.getEffectiveMinNotional();

            // Balance check
            if (ctx.balanceQuote < effectiveMinNotional) {
                this.latestState = `💤 USDC: $${ctx.balanceQuote.toFixed(2)} < $${effectiveMinNotional.toFixed(2)}`;
                return;
            }

            // ── Filter 1: Anti-Chop (ATR) ──
            const atrOk = atrPct > this.minAtrPct;

            // ── Filter 2: Tick Velocity (no spikes) ──
            const velocityOk = tickVelocity < this.maxTickVelocityPct;

            // ── Filter 3: OBI ──
            const obiOk = obi > this.obiThreshold;

            // ── Filter 4: Top-of-book OBI ──
            const topObiOk = topObi > 0.56;

            // ── Filter 5: Spread ──
            const spreadOk = spreadPct < this.maxSpreadPct;

            // ── Filter 6: Dual EMA Crossover ──
            const emaCrossOk = this.emaFast > this.emaSlow;
            const trendStrengthOk = emaGapPct > Math.max(spreadPct * 0.35, 0.0025);

            // ── Filter 7: VWAP ──
            const vwapOk = price <= vwap * 1.0001; // Buy at or below VWAP (discount)

            // ── Filter 8: Microprice & best-bid dominance ──
            const microPriceOk = microPriceEdgePct > 0;
            const depthRatioOk = depthRatio > 1.08;

            // ── Bonus: Absorption signal ──
            const absorptionBoost = absorption.bullish; // Ask wall eating = strong buy

            // Score system: each filter adds points, trade when score >= threshold
            let score = 0;
            const scoreReasons: string[] = [];

            if (obiOk) { score += 2; } else { scoreReasons.push(`OBI:${(obi * 100).toFixed(0)}%`); }
            if (topObiOk) { score += 2; } else { scoreReasons.push(`TopOBI:${(topObi * 100).toFixed(0)}%`); }
            if (spreadOk) { score += 1; } else { scoreReasons.push(`Sprd:${spreadPct.toFixed(3)}%`); }
            if (emaCrossOk) { score += 1; } else { scoreReasons.push('EMA↓'); }
            if (trendStrengthOk) { score += 1; } else { scoreReasons.push(`Trend:${emaGapPct.toFixed(3)}%`); }
            if (vwapOk) { score += 1; } else { scoreReasons.push('VWAP↑'); }
            if (microPriceOk) { score += 1; } else { scoreReasons.push(`Micro:${microPriceEdgePct.toFixed(4)}%`); }
            if (depthRatioOk) { score += 1; } else { scoreReasons.push(`Depth:${depthRatio.toFixed(2)}`); }
            if (atrOk) { score += 1; } else { scoreReasons.push('Chop'); }
            if (velocityOk) { score += 1; } else { scoreReasons.push('Spike'); }
            if (absorptionBoost) { score += 2; scoreReasons.push('🔥Absorb!'); }

            const minScore = 8;
            const maxScore = 13;

            if (score < minScore) {
                this.latestState = `🔍 Score: ${score}/${minScore} | ${scoreReasons.join(' ')}`;
                return;
            }

            const conviction = Math.min(Math.max((score - minScore) / Math.max(maxScore - minScore, 1), 0), 1);
            this.tradeConviction = conviction;
            this.latestConviction = conviction;

            // ── Position Sizing ──
            const minEntryNotional = effectiveMinNotional * this.entrySafetyMultiplier;
            const lossPenalty = Math.min(this.consecutiveLosses * this.lossPenaltyPerStreak, 0.20);
            const allocation = Math.min(Math.max(this.baseRiskAllocation + conviction * this.scoreRiskBonus - lossPenalty, 0.30), 0.90);
            const dynamicCap = Math.max(minEntryNotional, this.maxPositionNotional * (0.65 + conviction * 0.35));
            const allocationQuote = ctx.balanceQuote * allocation;
            const quoteToSpend = Math.min(ctx.balanceQuote, Math.max(minEntryNotional, Math.min(allocationQuote, dynamicCap)));
            let qty = quoteToSpend / price;
            qty = this.floorQuantity(qty);
            const entryNotional = qty * price;
            const effectiveMinQty = this.getEffectiveMinQty();

            if (qty <= 0) {
                this.latestState = "⚠️ Qty trop faible";
                return;
            }

            if (effectiveMinQty > 0 && qty < effectiveMinQty) {
                this.latestState = `⚠️ Qty ${qty} < minQty ${effectiveMinQty}`;
                return;
            }

            if (entryNotional < minEntryNotional) {
                this.latestState = `💤 Notional reel trop faible: $${entryNotional.toFixed(2)} < $${minEntryNotional.toFixed(2)}`;
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

            Logger.success(`📊 [Pro] ENTRY! Score:${score} Conv:${(conviction * 100).toFixed(0)}% OBI:${(obi * 100).toFixed(0)}% Top:${(topObi * 100).toFixed(0)}% EMA:${this.emaFast.toFixed(0)}/${this.emaSlow.toFixed(0)} ATR:${atrPct.toFixed(4)}%`);
            Logger.info(`[Pro] TP:$${this.takeProfitPrice.toFixed(2)} SL:$${this.stopLossPrice.toFixed(2)} Trail:${(this.currentTrailingPct * 100).toFixed(3)}% Qty:${qty}`);

            try {
                const result = await exchange.placeMarketBuy(symbol, qty);
                this.positionOpen = true;
                this.buyPrice = price;
                this.actualQuantity = result.actualQuantity;
                this.untrackedWalletPositionSeen = false;
                this.exitBlockedByNotional = false;
                this.latestState = `📈 Long @ $${price.toFixed(2)} | Score:${score}`;
                Tracker.addTrade('BUY', price, this.actualQuantity);
            } catch (e) {
                Logger.error("Pro BUY échoué");
                this.latestState = "❌ Buy failed";
                this.cooldownTicks = 5;
            }
        } else {
            // ══════════════════════════════════════════════════
            // ──────────── EXIT LOGIC ────────────
            // ══════════════════════════════════════════════════

            if (ctx.balanceBTC > 0 && this.isDustQuantity(ctx.balanceBTC, price)) {
                this.ignoreDustPosition("wallet sous le seuil de vente", price, ctx.balanceBTC);
                return;
            }

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
            const minExitNotional = this.getEffectiveMinNotional() * this.exitSafetyMultiplier;
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

            const strongTrendContinuation =
                this.tpExtensionsUsed < this.maxTpExtensions &&
                price >= this.takeProfitPrice &&
                obi > Math.max(this.obiThreshold + 0.05, 0.64) &&
                topObi > 0.60 &&
                this.emaFast > this.emaSlow &&
                microPriceEdgePct > 0 &&
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
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    this.cooldownTicks = 3;
                    this.consecutiveLosses = 0;
                    this.latestState = "✅ Profit encaissé!";
                    Tracker.addTrade('SELL', price, sellQty);
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
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    // Longer cooldown after loss streak
                    this.cooldownTicks = this.consecutiveLosses >= this.maxConsecutiveLosses ? 15 : 5;
                    this.latestState = wasProfit ? "📈 Trailing profit!" : `🛡️ SL (streak: ${this.consecutiveLosses})`;
                    Tracker.addTrade('SELL', price, sellQty);
                } catch (e) { Logger.error("Pro SELL (SL) échoué"); }
                return;
            }

            // 3. OBI Reversal Exit
            if (obi < this.obiExitThreshold && this.emaFast <= this.emaSlow) {
                if (!canSendSellOrder) {
                    this.blockExitBecauseExchangeFilters(price, sellQty, "OBI reversal");
                    return;
                }
                Logger.warn(`⚡ [Pro] OBI Reversal (${(obi * 100).toFixed(1)}%) @ $${price.toFixed(2)}`);
                try {
                    const wasProfit = price > this.buyPrice;
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    this.cooldownTicks = 4;
                    if (!wasProfit) this.consecutiveLosses++;
                    else this.consecutiveLosses = 0;
                    this.latestState = "⚡ OBI Exit";
                    Tracker.addTrade('SELL', price, sellQty);
                } catch (e) { Logger.error("Pro SELL (OBI) échoué"); }
                return;
            }

            // 4. Bearish Absorption while holding → early exit
            if (absorption.bearish && price < this.buyPrice) {
                if (!canSendSellOrder) {
                    this.blockExitBecauseExchangeFilters(price, sellQty, "Emergency exit");
                    return;
                }
                Logger.warn(`🔥 [Pro] Bid Wall absorbed! Emergency exit @ $${price.toFixed(2)}`);
                try {
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.resetPositionState();
                    this.cooldownTicks = 5;
                    this.consecutiveLosses++;
                    this.latestState = "🔥 Absorption Exit";
                    Tracker.addTrade('SELL', price, sellQty);
                } catch (e) { Logger.error("Pro SELL (Absorb) échoué"); }
                return;
            }

            // ── Still holding ──
            const pnl = ((price - this.buyPrice) / this.buyPrice * 100).toFixed(3);
            this.latestState = `📈 $${this.buyPrice.toFixed(0)} | PnL:${pnl}% | TP:$${this.takeProfitPrice.toFixed(0)} | SL:$${this.stopLossPrice.toFixed(0)} | OBI:${(obi * 100).toFixed(0)}%`;
        }
    }
}
