import { Spot } from '@binance/connector';
import { Logger } from '../utils/logger';

export interface SymbolTradingRules {
    minNotional: number;
    minQty: number;
    stepSize: number;
}

export interface ExchangeErrorDetails {
    status: number | null;
    code: string | number | null;
    message: string;
    isAuthError: boolean;
}

export interface SpotSnapshotBalance {
    asset: string;
    free: number;
    locked: number;
}

export interface SpotAccountSnapshot {
    updateTime: number;
    totalAssetOfBtc: number;
    balances: SpotSnapshotBalance[];
}

export class Exchange {
    private client: typeof Spot;
    private symbolRulesCache = new Map<string, SymbolTradingRules>();

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

    async getHistoricalClosePrice(symbol: string, endTime: number, interval: string = '1m'): Promise<number> {
        try {
            const response = await this.client.klines(symbol, interval, { endTime, limit: 1 });
            const candle = response.data?.[0];
            if (!candle) {
                throw new Error(`No historical candle found for ${symbol}`);
            }
            return parseFloat(candle[4]);
        } catch (error: any) {
            Logger.error(`Failed to fetch historical close for ${symbol}`, error?.response?.data || error.message);
            throw error;
        }
    }

    async getLatestSpotAccountSnapshot(): Promise<SpotAccountSnapshot | null> {
        try {
            const response = await this.client.accountSnapshot('SPOT', { limit: 5 });
            const snapshots = response.data?.snapshotVos;
            if (!Array.isArray(snapshots) || snapshots.length === 0) {
                return null;
            }

            const latest = snapshots
                .map((snapshot: any) => ({
                    updateTime: Number(snapshot.updateTime || 0),
                    totalAssetOfBtc: parseFloat(snapshot.data?.totalAssetOfBtc || '0') || 0,
                    balances: Array.isArray(snapshot.data?.balances)
                        ? snapshot.data.balances.map((balance: any) => ({
                            asset: balance.asset,
                            free: parseFloat(balance.free || '0') || 0,
                            locked: parseFloat(balance.locked || '0') || 0,
                        }))
                        : [],
                }))
                .sort((left: SpotAccountSnapshot, right: SpotAccountSnapshot) => right.updateTime - left.updateTime)[0];

            return latest || null;
        } catch (error: any) {
            Logger.warn(`Failed to fetch spot account snapshot (${error?.response?.data?.msg || error?.message || error})`);
            return null;
        }
    }

    async getSymbolTradingRules(symbol: string): Promise<SymbolTradingRules> {
        const cacheKey = symbol.toUpperCase();
        const cached = this.symbolRulesCache.get(cacheKey);
        if (cached) {
            return cached;
        }

        try {
            const response = await this.client.exchangeInfo({ symbol: cacheKey });
            const symbolInfo = response.data?.symbols?.[0];
            if (!symbolInfo) {
                throw new Error(`No exchangeInfo found for ${cacheKey}`);
            }

            const filters = symbolInfo.filters || [];
            const notionalFilter = filters.find((filter: any) =>
                filter.filterType === 'NOTIONAL' || filter.filterType === 'MIN_NOTIONAL'
            );
            const lotSizeFilter = filters.find((filter: any) => filter.filterType === 'LOT_SIZE');
            const marketLotSizeFilter = filters.find((filter: any) => filter.filterType === 'MARKET_LOT_SIZE');

            const rules: SymbolTradingRules = {
                minNotional: parseFloat(notionalFilter?.minNotional || '0') || 0,
                minQty: parseFloat(marketLotSizeFilter?.minQty || lotSizeFilter?.minQty || '0') || 0,
                stepSize: parseFloat(marketLotSizeFilter?.stepSize || lotSizeFilter?.stepSize || '0') || 0,
            };

            this.symbolRulesCache.set(cacheKey, rules);
            return rules;
        } catch (error: any) {
            Logger.error(`Failed to fetch trading rules for ${symbol}`, error?.response?.data || error.message);
            throw error;
        }
    }

    async placeMarketBuy(symbol: string, quantity: number) {
        try {
            const response = await this.client.newOrder(symbol, 'BUY', 'MARKET', { quantity });
            const data = response.data;
            // Extract actually filled quantity after commission
            let filledQty = parseFloat(data.executedQty || quantity);
            if (data.fills && data.fills.length > 0) {
                const totalCommission = data.fills.reduce((sum: number, f: any) => sum + parseFloat(f.commission || '0'), 0);
                const commissionAsset = data.fills[0]?.commissionAsset;
                // If commission is taken from the bought asset (BTC), subtract it
                if (commissionAsset === symbol.replace(/USDC|USDT|BUSD|EUR/, '')) {
                    filledQty -= totalCommission;
                }
            }
            // Floor to 5 decimal places (Binance stepSize for BTC)
            filledQty = Math.floor(filledQty * 100000) / 100000;
            return { ...data, actualQuantity: filledQty };
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

    async getOrderBook(symbol: string, limit: number = 20): Promise<{ bids: [number, number][], asks: [number, number][] }> {
        try {
            const response = await this.client.depth(symbol, { limit });
            const bids = response.data.bids.map((b: any) => [parseFloat(b[0]), parseFloat(b[1])] as [number, number]);
            const asks = response.data.asks.map((a: any) => [parseFloat(a[0]), parseFloat(a[1])] as [number, number]);
            return { bids, asks };
        } catch (error: any) {
            Logger.error(`Order Book fetch failed for ${symbol}`, error?.response?.data || error.message);
            return { bids: [], asks: [] };
        }
    }

    public getErrorDetails(error: any): ExchangeErrorDetails {
        const status = error?.response?.status ?? null;
        const code = error?.response?.data?.code ?? error?.code ?? null;
        const message = error?.response?.data?.msg
            || error?.response?.statusText
            || error?.message
            || 'Unknown exchange error';
        const authCodes = new Set([-2015, -2014, -2008, -1022]);
        const isAuthError = status === 401 || (typeof code === 'number' && authCodes.has(code));

        return { status, code, message, isAuthError };
    }
}
