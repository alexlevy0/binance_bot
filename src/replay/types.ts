import type { SymbolTradingRules } from "../core/exchange";
import type { OpenPosition } from "../core/tracker";

export interface ReplaySessionHeader {
    type: 'session';
    version: 1;
    symbol: string;
    mode: 'live' | 'demo';
    recordedAt: string;
    initialBalances: {
        base: number;
        quote: number;
    };
    trackedOpenPosition: OpenPosition | null;
    exchangeRules: SymbolTradingRules;
}

export interface RecordedMarketTick {
    type: 'tick';
    time: number;
    price: number;
    bids: [number, number][];
    asks: [number, number][];
}

export type ReplayFileEntry = ReplaySessionHeader | RecordedMarketTick;
