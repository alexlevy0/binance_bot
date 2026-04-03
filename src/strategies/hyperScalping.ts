import type { ITradingStrategy, TickContext } from "./index";
import { Exchange } from "../core/exchange";
import { Logger } from "../utils/logger";
import { Tracker } from "../core/tracker";

export class HyperScalpingStrategy implements ITradingStrategy {
    private positionOpen: boolean = false;
    private buyPrice: number = 0;
    private actualQuantity: number = 0; // Real quantity after commission
    private tradeQuantity: number;

    // Profit & Loss Thresholds
    private minProfitMargin: number;
    private stopLossMargin: number;

    public latestState: string = "En attente...";

    // Temps de pause entre chaque trade
    private cooldownTicks: number = 0;

    constructor(quantity: number = 0.001, profitMargin: number = 1.0002, stopLoss: number = 0.9995) {
        this.tradeQuantity = quantity;
        this.minProfitMargin = profitMargin;
        this.stopLossMargin = stopLoss;
    }

    async onTick(price: number, exchange: Exchange, symbol: string, ctx: TickContext): Promise<void> {
        // Mode Pause si un trade a lieu récemment
        if (this.cooldownTicks > 0) {
            this.cooldownTicks--;
            this.latestState = `Repos post-trade (${this.cooldownTicks * 2}s)...`;
            return;
        }

        if (!this.positionOpen) {
            Logger.success(`⚡ [HyperScalping] Achat Market initié à ${price}`);
            try {
                const result = await exchange.placeMarketBuy(symbol, this.tradeQuantity);
                this.positionOpen = true;
                this.buyPrice = price;
                this.actualQuantity = result.actualQuantity; // Use real quantity after fees
                this.latestState = `Position longue à $${this.buyPrice.toFixed(2)} (qty: ${this.actualQuantity})`;
                Tracker.addTrade('BUY', price, this.tradeQuantity);
                Logger.info(`[HyperScalping] Quantité réelle reçue après commission: ${this.actualQuantity}`);
            } catch (e) {
                Logger.error("Échec de l'achat Scalping");
            }
        }
        else {
            const targetProfit = this.buyPrice * this.minProfitMargin;
            const stopLoss = this.buyPrice * this.stopLossMargin;

            if (price >= targetProfit) {
                Logger.success(`🚀 [HyperScalping] Take-Profit (+)! Vente flash à ${price}.`);
                try {
                    await exchange.placeMarketSell(symbol, this.actualQuantity);
                    this.positionOpen = false;
                    this.cooldownTicks = 3;
                    this.latestState = "Profit réussi. Repos.";
                    Tracker.addTrade('SELL', price, this.actualQuantity);
                } catch (e) {
                    Logger.error("Échec de la vente Scalping");
                }
            }
            else if (price <= stopLoss) {
                Logger.warn(`🛑 [HyperScalping] Stop-Loss (-). Vente perte à ${price}.`);
                try {
                    await exchange.placeMarketSell(symbol, this.actualQuantity);
                    this.positionOpen = false;
                    this.cooldownTicks = 5;
                    this.latestState = "Pertes protégées. Repos.";
                    Tracker.addTrade('SELL', price, this.actualQuantity);
                } catch (e) {
                    Logger.error("Échec de la vente Scalping");
                }
            }
            else {
                this.latestState = `Attente Cible: ${targetProfit.toFixed(2)} | Stop: ${stopLoss.toFixed(2)}`;
            }
        }
    }
}
