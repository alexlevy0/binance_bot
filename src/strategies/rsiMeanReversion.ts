import type { ITradingStrategy } from "./index";
import { Exchange } from "../core/exchange";
import { Logger } from "../utils/logger";
import { calculateRSI } from "../utils/indicators";
import { Tracker } from "../core/tracker";

export class RsiMeanReversionStrategy implements ITradingStrategy {
    private rsiPeriod: number;
    private buyThreshold: number;
    private sellThreshold: number;
    private positionOpen: boolean = false;
    private tradeQuantity: number;
    public latestRsi: number = 50;

    constructor(rsiPeriod: number = 14, buyThreshold: number = 30, sellThreshold: number = 70, quantity: number = 0.001) {
        this.rsiPeriod = rsiPeriod;
        this.buyThreshold = buyThreshold;
        this.sellThreshold = sellThreshold;
        this.tradeQuantity = quantity;
    }

    async onTick(price: number, exchange: Exchange): Promise<void> {
        try {
            // 1. Fetch recent 15m candlesticks history
            // Passing symbol explicitly based on default Pair
            const closes = await exchange.getKlines('BTCUSDT', '15m', 100);

            // 2. We add the live current tick price to the end to formulate a real-time 'live' candle
            closes.push(price);

            // 3. Compute the latest RSI mathematically
            const currentRsi = calculateRSI(closes, this.rsiPeriod);
            this.latestRsi = currentRsi;

            Logger.info(`📊 [RsiMeanReversion] Current 15m RSI: ${currentRsi.toFixed(2)}`);

            // 4. Act according to Mean Reversion theories
            if (!this.positionOpen && currentRsi <= this.buyThreshold) {
                Logger.success(`📉 Oversold Alert! RSI dropped to ${currentRsi.toFixed(2)}. Initiating BUY.`);
                // Place an actual Buy Order on the Exchange via Spot connector
                // (will simulate beautifully in Demo Testnet thanks to setup)
                await exchange.placeMarketBuy('BTCUSDT', this.tradeQuantity);
                this.positionOpen = true;
                Tracker.addTrade('BUY', price, this.tradeQuantity);
            }
            else if (this.positionOpen && currentRsi >= this.sellThreshold) {
                Logger.success(`📈 Overbought Alert! RSI climbed to ${currentRsi.toFixed(2)}. Initiating SELL to take profit.`);
                // Extract equity via Sell Order out of the position
                await exchange.placeMarketSell('BTCUSDT', this.tradeQuantity);
                this.positionOpen = false;
                Tracker.addTrade('SELL', price, this.tradeQuantity);
            }

        } catch (error) {
            Logger.error("Error evaluating RsiMeanReversion logic computation");
        }
    }
}
