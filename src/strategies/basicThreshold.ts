import type { ITradingStrategy } from "./index";
import { Exchange } from "../core/exchange";
import { Logger } from "../utils/logger";

export class BasicThresholdStrategy implements ITradingStrategy {
    private buyThreshold: number;
    private hasBought: boolean = false;

    constructor(buyThreshold: number = 65000) {
        this.buyThreshold = buyThreshold;
    }

    async onTick(price: number, exchange: Exchange): Promise<void> {
        if (!this.hasBought && price < this.buyThreshold) {
            Logger.info(`Price ${price} is below threshold ${this.buyThreshold}. Initiating BUY.`);
            try {
                // Place a simulated market buy of 0.001 BTC
                await exchange.placeMarketBuy('BTCUSDT', 0.001);
                this.hasBought = true;
                Logger.success("BasicThreshold BUY executed.");
            } catch (e) {
                Logger.error("Failed to execute buy within strategy");
            }
        }
    }
}
