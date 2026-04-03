import { Exchange } from "../core/exchange";

export interface ITradingStrategy {
    /**
     * Called on every tick by the core Bot orchestrator
     * @param price Current price of the asset
     * @param exchange Instance of the exchange client for placing orders
     */
    onTick(price: number, exchange: Exchange): Promise<void>;
}
