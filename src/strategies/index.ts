import { Exchange } from "../core/exchange";

export interface TickContext {
    balanceBTC: number;
    balanceQuote: number;
    bids: [number, number][];  // From WebSocket depth stream
    asks: [number, number][];  // From WebSocket depth stream
}

export interface ITradingStrategy {
    /**
     * Called on every tick by the core Bot orchestrator
     * @param price Current price of the asset
     * @param exchange Instance of the exchange client for placing orders
     * @param symbol Trading pair symbol
     * @param ctx Context with balance info
     */
    onTick(price: number, exchange: Exchange, symbol: string, ctx: TickContext): Promise<void>;
}
