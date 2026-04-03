import type { ITradingStrategy } from "./index";
import { Exchange } from "../core/exchange";
import { Logger } from "../utils/logger";
import { Tracker } from "../core/tracker";

export class HyperScalpingStrategy implements ITradingStrategy {
    private positionOpen: boolean = false;
    private buyPrice: number = 0;
    private tradeQuantity: number;

    // Profit & Loss Thresholds
    private minProfitMargin: number; // 1.0002 = 0.02%
    private stopLossMargin: number;  // 0.9995 = 0.05%

    public latestState: string = "En attente...";

    // Temps de pause entre chaque trade
    private cooldownTicks: number = 0;

    constructor(quantity: number = 0.001, profitMargin: number = 1.0002, stopLoss: number = 0.9995) {
        this.tradeQuantity = quantity;
        this.minProfitMargin = profitMargin;
        this.stopLossMargin = stopLoss;
    }

    async onTick(price: number, exchange: Exchange): Promise<void> {
        // Mode Pause si un trade a lieu récemment
        if (this.cooldownTicks > 0) {
            this.cooldownTicks--;
            this.latestState = `Repos post-trade (${this.cooldownTicks * 2}s)...`;
            return;
        }

        if (!this.positionOpen) {
            Logger.success(`⚡ [HyperScalping] Achat Market initié à ${price}`);
            try {
                await exchange.placeMarketBuy('BTCUSDT', this.tradeQuantity);
                this.positionOpen = true;
                this.buyPrice = price;
                this.latestState = `Position longue à $${this.buyPrice.toFixed(2)}`;
                Tracker.addTrade('BUY', price, this.tradeQuantity);
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
                    await exchange.placeMarketSell('BTCUSDT', this.tradeQuantity);
                    this.positionOpen = false;
                    this.cooldownTicks = 3; // Pause de 6 secondes
                    this.latestState = "Profit réussi. Repos.";
                    Tracker.addTrade('SELL', price, this.tradeQuantity);
                } catch (e) {
                    Logger.error("Échec de la vente Scalping");
                }
            }
            else if (price <= stopLoss) {
                Logger.warn(`🛑 [HyperScalping] Stop-Loss (-). Vente perte à ${price}.`);
                try {
                    await exchange.placeMarketSell('BTCUSDT', this.tradeQuantity);
                    this.positionOpen = false;
                    this.cooldownTicks = 5; // Longue pause de 10 secondes
                    this.latestState = "Pertes protégées. Repos.";
                    Tracker.addTrade('SELL', price, this.tradeQuantity);
                } catch (e) {
                    Logger.error("Échec de la vente Scalping");
                }
            }
            else {
                // Affiche les prix exacts d'attente à l'utilisateur sur le Dashboard !
                this.latestState = `Attente Cible: ${targetProfit.toFixed(2)} | Stop: ${stopLoss.toFixed(2)}`;
            }
        }
    }
}
