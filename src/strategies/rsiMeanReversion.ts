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
    private actualQuantity: number = 0;
    public latestRsi: number = 50;

    constructor(rsiPeriod: number = 14, buyThreshold: number = 30, sellThreshold: number = 70, quantity: number = 0.001) {
        this.rsiPeriod = rsiPeriod;
        this.buyThreshold = buyThreshold;
        this.sellThreshold = sellThreshold;
        this.tradeQuantity = quantity;
    }

    async onTick(price: number, exchange: Exchange, symbol: string): Promise<void> {
        try {
            // 1. Fetch recent 15m candlesticks history
            const closes = await exchange.getKlines(symbol, '15m', 100);

            // 2. We add the live current tick price to the end to formulate a real-time 'live' candle
            closes.push(price);

            // 3. Compute the latest RSI mathematically
            const currentRsi = calculateRSI(closes, this.rsiPeriod);
            this.latestRsi = currentRsi;

            Logger.info(`📊 [RsiMeanReversion] Current 15m RSI: ${currentRsi.toFixed(2)}`);

            // 4. Act according to Mean Reversion theories
            if (!this.positionOpen && currentRsi <= this.buyThreshold) {
                Logger.success(`📉 Oversold Alert! RSI dropped to ${currentRsi.toFixed(2)}. Initiating BUY.`);
                const result = await exchange.placeMarketBuy(symbol, this.tradeQuantity);
                this.positionOpen = true;
                this.actualQuantity = result.actualQuantity;
                Tracker.addTrade('BUY', price, this.actualQuantity);
            }
            else if (this.positionOpen && currentRsi >= this.sellThreshold) {
                Logger.success(`📈 Overbought Alert! RSI climbed to ${currentRsi.toFixed(2)}. Initiating SELL to take profit.`);
                const sellQuantity = this.actualQuantity || this.tradeQuantity;
                if (sellQuantity <= 0) {
                    this.positionOpen = false;
                    this.latestRsi = currentRsi;
                    return;
                }
                await exchange.placeMarketSell(symbol, sellQuantity);
                this.positionOpen = false;
                this.actualQuantity = 0;
                Tracker.addTrade('SELL', price, sellQuantity);
            }

        } catch (error) {
            Logger.error("Error evaluating RsiMeanReversion logic computation");
        }
    }
}
