import { Spot } from '@binance/connector';
import { Logger } from '../utils/logger';

export class Exchange {
    private client: typeof Spot;

    constructor(apiKey: string, secretKey: string, baseURL: string) {
        this.client = new Spot(apiKey, secretKey, { baseURL });
    }

    async ping(): Promise<boolean> {
        try {
            await this.client.ping();
            return true;
        } catch (error: any) {
            Logger.error("Ping Failed", error?.response?.data || error.message);
            return false;
        }
    }

    async getBalances() {
        try {
            const response = await this.client.account();
            const balances = response.data.balances.filter((b: any) => parseFloat(b.free) > 0 || parseFloat(b.locked) > 0);
            return balances;
        } catch (error: any) {
            Logger.error("Failed to fetch balances", error?.response?.data || error.message);
            throw error;
        }
    }

    async getTickerPrice(symbol: string): Promise<number> {
        try {
            const response = await this.client.tickerPrice(symbol);
            return parseFloat(response.data.price);
        } catch (error: any) {
            Logger.error(`Failed to fetch price for ${symbol}`, error?.response?.data || error.message);
            throw error;
        }
    }

    async getKlines(symbol: string, interval: string = '15m', limit: number = 100): Promise<number[]> {
        try {
            const response = await this.client.klines(symbol, interval, { limit });
            // Binance klines format returns an array of arrays.
            // Index 4 is the closing price of the candlestick.
            return response.data.map((candle: any[]) => parseFloat(candle[4]));
        } catch (error: any) {
            Logger.error(`Failed to fetch klines for ${symbol}`, error?.response?.data || error.message);
            throw error;
        }
    }

    async getChartKlines(symbol: string, interval: string = '1m', limit: number = 100): Promise<any[]> {
        try {
            const response = await this.client.klines(symbol, interval, { limit });
            return response.data.map((c: any[]) => ({
                time: Math.floor(c[0] / 1000), // Lightweight Charts wants UNIX timestamp in seconds
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4])
            }));
        } catch (error: any) {
            Logger.error(`Failed to fetch chart klines for ${symbol}`, error?.response?.data || error.message);
            return [];
        }
    }

    async placeMarketBuy(symbol: string, quantity: number) {
        try {
            const response = await this.client.newOrder(symbol, 'BUY', 'MARKET', { quantity });
            return response.data;
        } catch (error: any) {
            Logger.error(`Buy Order Failed for ${symbol}`, error?.response?.data || error.message);
            throw error;
        }
    }

    async placeMarketSell(symbol: string, quantity: number) {
        try {
            const response = await this.client.newOrder(symbol, 'SELL', 'MARKET', { quantity });
            return response.data;
        } catch (error: any) {
            Logger.error(`Sell Order Failed for ${symbol}`, error?.response?.data || error.message);
            throw error;
        }
    }
}
