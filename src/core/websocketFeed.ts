import { Logger } from "../utils/logger";

type TradeCallback = (price: number, qty: number, isBuyerMaker: boolean) => void;
type DepthCallback = (bids: [number, number][], asks: [number, number][]) => void;
type BookTickerCallback = (bestBid: number, bestBidQty: number, bestAsk: number, bestAskQty: number) => void;

/**
 * WebSocketFeed — Real-time Binance market data via WebSocket
 * 
 * Subscribes to:
 * - <symbol>@trade — Real-time trade stream (price updates at ~ms latency)
 * - <symbol>@depth20@100ms — Top 20 order book levels every 100ms
 * - <symbol>@bookTicker — Best bid/ask in real-time
 */
export class WebSocketFeed {
    private ws: WebSocket | null = null;
    private symbol: string;
    private baseUrl: string;
    private reconnectAttempts: number = 0;
    private maxReconnectAttempts: number = 10;
    private isRunning: boolean = false;

    // Callbacks
    public onTrade: TradeCallback | null = null;
    public onDepth: DepthCallback | null = null;
    public onBookTicker: BookTickerCallback | null = null;

    // Latest state (cached for strategy access)
    public latestPrice: number = 0;
    public latestBids: [number, number][] = [];
    public latestAsks: [number, number][] = [];
    public bestBid: number = 0;
    public bestAsk: number = 0;
    public bestBidQty: number = 0;
    public bestAskQty: number = 0;

    constructor(symbol: string, isLive: boolean) {
        this.symbol = symbol.toLowerCase();
        // Binance WebSocket endpoints
        this.baseUrl = isLive
            ? 'wss://stream.binance.com:9443'
            : 'wss://testnet.binance.vision';
    }

    public start() {
        this.isRunning = true;
        this.connect();
    }

    public stop() {
        this.isRunning = false;
        if (this.ws) {
            this.ws.close();
            this.ws = null;
        }
        Logger.info('🔌 WebSocket feed stopped');
    }

    private connect() {
        const streams = [
            `${this.symbol}@trade`,
            `${this.symbol}@depth20@100ms`,
            `${this.symbol}@bookTicker`
        ];

        const url = `${this.baseUrl}/stream?streams=${streams.join('/')}`;
        Logger.info(`🔌 Connecting to WebSocket: ${streams.join(', ')}`);

        try {
            this.ws = new WebSocket(url);

            this.ws.onopen = () => {
                this.reconnectAttempts = 0;
                Logger.success('✅ WebSocket connected — Real-time data active');
            };

            this.ws.onmessage = (event: MessageEvent) => {
                try {
                    const msg = JSON.parse(event.data as string);
                    this.handleMessage(msg);
                } catch (e) {
                    // Ignore parse errors
                }
            };

            this.ws.onclose = () => {
                if (this.isRunning) {
                    this.reconnect();
                }
            };

            this.ws.onerror = (error: Event) => {
                Logger.error('WebSocket error, will reconnect...');
            };

            // Handle ping/pong — Bun's WebSocket handles pong automatically
            // but we set up a keepalive just in case
        } catch (e) {
            Logger.error('Failed to create WebSocket connection');
            if (this.isRunning) {
                this.reconnect();
            }
        }
    }

    private reconnect() {
        if (this.reconnectAttempts >= this.maxReconnectAttempts) {
            Logger.error(`❌ WebSocket reconnect failed after ${this.maxReconnectAttempts} attempts`);
            return;
        }

        this.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, this.reconnectAttempts), 30000); // Exponential backoff, max 30s
        Logger.warn(`🔄 WebSocket reconnecting in ${delay}ms (attempt ${this.reconnectAttempts}/${this.maxReconnectAttempts})`);

        setTimeout(() => {
            if (this.isRunning) {
                this.connect();
            }
        }, delay);
    }

    private handleMessage(msg: any) {
        if (!msg.stream || !msg.data) return;

        const stream = msg.stream as string;
        const data = msg.data;

        // ── Trade Stream ──
        if (stream.endsWith('@trade')) {
            const price = parseFloat(data.p);
            const qty = parseFloat(data.q);
            const isBuyerMaker = data.m;
            this.latestPrice = price;
            if (this.onTrade) {
                this.onTrade(price, qty, isBuyerMaker);
            }
        }

        // ── Depth Stream (top 20 levels) ──
        else if (stream.includes('@depth')) {
            const bids: [number, number][] = (data.bids || []).map((b: any) =>
                [parseFloat(b[0]), parseFloat(b[1])] as [number, number]
            );
            const asks: [number, number][] = (data.asks || []).map((a: any) =>
                [parseFloat(a[0]), parseFloat(a[1])] as [number, number]
            );
            this.latestBids = bids;
            this.latestAsks = asks;
            if (this.onDepth) {
                this.onDepth(bids, asks);
            }
        }

        // ── Book Ticker Stream ──
        else if (stream.endsWith('@bookTicker')) {
            this.bestBid = parseFloat(data.b);
            this.bestBidQty = parseFloat(data.B);
            this.bestAsk = parseFloat(data.a);
            this.bestAskQty = parseFloat(data.A);
            if (this.onBookTicker) {
                this.onBookTicker(this.bestBid, this.bestBidQty, this.bestAsk, this.bestAskQty);
            }
        }
    }
}
