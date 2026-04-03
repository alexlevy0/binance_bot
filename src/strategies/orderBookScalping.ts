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
        tpMultiplier: number = 2.5,
        slMultiplier: number = 4.0,
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

    async onTick(price: number, exchange: Exchange, symbol: string, ctx: TickContext): Promise<void> {
        // ── Update all indicators ──
        this.updateEMA(price);
        const atrPct = this.updateATR(price);
        const tickVelocity = this.getTickVelocity(price);

        // Cooldown
        if (this.cooldownTicks > 0) {
            this.cooldownTicks--;
            this.latestState = `⏸️ Cooldown (${this.cooldownTicks}s) | ATR: ${atrPct.toFixed(4)}%`;
            return;
        }

        // ── Detect existing BTC position on boot ──
        if (!this.positionOpen && ctx.balanceBTC > 0) {
            const btcValue = ctx.balanceBTC * price;
            if (btcValue >= this.minNotional) {
                this.positionOpen = true;
                this.buyPrice = price;
                this.actualQuantity = Math.floor(ctx.balanceBTC * 100000) / 100000;
                this.highestPriceSinceEntry = price;
                this.takeProfitPrice = price * 1.0003;
                this.stopLossPrice = price * 0.9995;
                this.trailingStopPrice = price * (1 - this.trailingStopPct);
                Logger.info(`[OrderBook] Position BTC existante: ${this.actualQuantity} BTC (~$${btcValue.toFixed(2)})`);
                this.latestState = `📈 Position récupérée @ $${price.toFixed(2)}`;
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
        const obi = totalBidVol / (totalBidVol + totalAskVol);
        this.latestOBI = obi;

        const bestBid = bids[0]![0];
        const bestAsk = asks[0]![0];
        const spreadAbs = bestAsk - bestBid;
        const spreadPct = (spreadAbs / price) * 100;
        this.latestSpread = spreadPct;

        const vwap = this.calculateVWAP(bids, asks);
        const absorption = this.detectAbsorption(bids, asks);

        // ══════════════════════════════════════════════════
        // ──────────── ENTRY LOGIC ────────────
        // ══════════════════════════════════════════════════
        if (!this.positionOpen) {
            // Balance check
            if (ctx.balanceQuote < this.minNotional) {
                this.latestState = `💤 USDC: $${ctx.balanceQuote.toFixed(2)} < $${this.minNotional}`;
                return;
            }

            // ── Filter 1: Anti-Chop (ATR) ──
            const atrOk = atrPct > this.minAtrPct;

            // ── Filter 2: Tick Velocity (no spikes) ──
            const velocityOk = tickVelocity < this.maxTickVelocityPct;

            // ── Filter 3: OBI ──
            const obiOk = obi > this.obiThreshold;

            // ── Filter 4: Spread ──
            const spreadOk = spreadPct < this.maxSpreadPct;

            // ── Filter 5: Dual EMA Crossover ──
            const emaCrossOk = this.emaFast > this.emaSlow;

            // ── Filter 6: VWAP ──
            const vwapOk = price <= vwap * 1.0001; // Buy at or below VWAP (discount)

            // ── Bonus: Absorption signal ──
            const absorptionBoost = absorption.bullish; // Ask wall eating = strong buy

            // Score system: each filter adds points, trade when score >= threshold
            let score = 0;
            const scoreReasons: string[] = [];

            if (obiOk) { score += 2; } else { scoreReasons.push(`OBI:${(obi * 100).toFixed(0)}%`); }
            if (spreadOk) { score += 1; } else { scoreReasons.push(`Sprd:${spreadPct.toFixed(3)}%`); }
            if (emaCrossOk) { score += 2; } else { scoreReasons.push('EMA↓'); }
            if (vwapOk) { score += 1; } else { scoreReasons.push('VWAP↑'); }
            if (atrOk) { score += 1; } else { scoreReasons.push('Chop'); }
            if (velocityOk) { score += 1; } else { scoreReasons.push('Spike'); }
            if (absorptionBoost) { score += 2; scoreReasons.push('🔥Absorb!'); }

            const minScore = 6; // Need at least 6/10 points

            if (score < minScore) {
                this.latestState = `🔍 Score: ${score}/${minScore} | ${scoreReasons.join(' ')}`;
                return;
            }

            // ── Position Sizing ──
            const quoteToSpend = Math.min(ctx.balanceQuote * 0.80, 10);
            let qty = quoteToSpend / price;
            qty = Math.floor(qty * 100000) / 100000;

            if (qty <= 0) {
                this.latestState = "⚠️ Qty trop faible";
                return;
            }

            // ── Dynamic TP/SL scaled by ATR ──
            const effectiveSpread = Math.max(spreadAbs, 1.0);
            const atrScale = Math.max(atrPct / 0.01, 0.5); // Scale TP/SL by volatility
            this.takeProfitPrice = price + (effectiveSpread * this.tpMultiplier * atrScale);
            this.stopLossPrice = price - (effectiveSpread * this.slMultiplier * atrScale);
            this.trailingStopPrice = price * (1 - this.trailingStopPct);
            this.highestPriceSinceEntry = price;

            Logger.success(`📊 [Pro] ENTRY! Score:${score} OBI:${(obi * 100).toFixed(0)}% EMA:${this.emaFast.toFixed(0)}/${this.emaSlow.toFixed(0)} VWAP:${vwap.toFixed(0)} ATR:${atrPct.toFixed(4)}%`);
            Logger.info(`[Pro] TP:$${this.takeProfitPrice.toFixed(2)} SL:$${this.stopLossPrice.toFixed(2)} Trail:$${this.trailingStopPrice.toFixed(2)} Qty:${qty}`);

            try {
                const result = await exchange.placeMarketBuy(symbol, qty);
                this.positionOpen = true;
                this.buyPrice = price;
                this.actualQuantity = result.actualQuantity;
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

            // ── Update Trailing Stop ──
            if (price > this.highestPriceSinceEntry) {
                this.highestPriceSinceEntry = price;
                const newTrailing = price * (1 - this.trailingStopPct);
                if (newTrailing > this.trailingStopPrice) {
                    this.trailingStopPrice = newTrailing;
                }
                // Also raise SL if trailing is higher
                if (this.trailingStopPrice > this.stopLossPrice) {
                    this.stopLossPrice = this.trailingStopPrice;
                }
            }

            // Use real wallet balance for sells (commission-safe)
            const sellQty = Math.floor(ctx.balanceBTC * 100000) / 100000;

            // 1. Take-Profit
            if (price >= this.takeProfitPrice) {
                Logger.success(`🚀 [Pro] Take-Profit! $${price.toFixed(2)} ≥ $${this.takeProfitPrice.toFixed(2)}`);
                try {
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.positionOpen = false;
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
                if (wasProfit) {
                    Logger.success(`📈 [Pro] Trailing Stop (profit lock)! $${price.toFixed(2)}`);
                } else {
                    Logger.warn(`🛑 [Pro] Stop-Loss! $${price.toFixed(2)} ≤ $${this.stopLossPrice.toFixed(2)}`);
                    this.consecutiveLosses++;
                }
                try {
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.positionOpen = false;
                    // Longer cooldown after loss streak
                    this.cooldownTicks = this.consecutiveLosses >= this.maxConsecutiveLosses ? 15 : 5;
                    this.latestState = wasProfit ? "📈 Trailing profit!" : `🛡️ SL (streak: ${this.consecutiveLosses})`;
                    Tracker.addTrade('SELL', price, sellQty);
                } catch (e) { Logger.error("Pro SELL (SL) échoué"); }
                return;
            }

            // 3. OBI Reversal Exit
            if (obi < this.obiExitThreshold) {
                Logger.warn(`⚡ [Pro] OBI Reversal (${(obi * 100).toFixed(1)}%) @ $${price.toFixed(2)}`);
                try {
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.positionOpen = false;
                    this.cooldownTicks = 4;
                    const wasProfit = price > this.buyPrice;
                    if (!wasProfit) this.consecutiveLosses++;
                    else this.consecutiveLosses = 0;
                    this.latestState = "⚡ OBI Exit";
                    Tracker.addTrade('SELL', price, sellQty);
                } catch (e) { Logger.error("Pro SELL (OBI) échoué"); }
                return;
            }

            // 4. Bearish Absorption while holding → early exit
            if (absorption.bearish && price < this.buyPrice) {
                Logger.warn(`🔥 [Pro] Bid Wall absorbed! Emergency exit @ $${price.toFixed(2)}`);
                try {
                    await exchange.placeMarketSell(symbol, sellQty);
                    this.positionOpen = false;
                    this.cooldownTicks = 5;
                    this.consecutiveLosses++;
                    this.latestState = "🔥 Absorption Exit";
                    Tracker.addTrade('SELL', price, sellQty);
                } catch (e) { Logger.error("Pro SELL (Absorb) échoué"); }
                return;
            }

            // ── Still holding ──
            const pnl = ((price - this.buyPrice) / this.buyPrice * 100).toFixed(3);
            this.latestState = `📈 $${this.buyPrice.toFixed(0)} | PnL:${pnl}% | Trail:$${this.trailingStopPrice.toFixed(0)} | OBI:${(obi * 100).toFixed(0)}%`;
        }
    }
}
