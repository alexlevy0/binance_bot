import { existsSync, readdirSync, readFileSync } from "fs";
import { basename, resolve } from "path";
import { Exchange, type SymbolTradingRules } from "../core/exchange";
import { Tracker } from "../core/tracker";
import { Logger } from "../utils/logger";
import { OrderBookScalpingStrategy } from "../strategies/orderBookScalping";
import type { TickContext } from "../strategies";
import { getReplayDirectory } from "./marketRecorder";
import type { RecordedMarketTick, ReplayFileEntry, ReplaySessionHeader } from "./types";

interface ReplayModeOptions {
    filePath?: string | null;
    useLatest?: boolean;
    optimize?: boolean;
    initialQuoteOverride?: number | null;
    initialBaseOverride?: number | null;
}

interface StrategyPreset {
    maxSpreadPct: number;
    obiThreshold: number;
    obiExitThreshold: number;
    tpMultiplier: number;
    slMultiplier: number;
    minNotional: number;
    minScore: number;
}

interface ClosedTrade {
    entryTime: number;
    exitTime: number;
    quantity: number;
    entryPrice: number;
    exitPrice: number;
    pnlQuote: number;
}

interface ReplayRunResult {
    preset: StrategyPreset;
    netPnlQuote: number;
    returnPct: number;
    totalTrades: number;
    winRate: number;
    profitFactor: number;
    maxDrawdownPct: number;
    feesPaidQuote: number;
    endingQuote: number;
    endingBase: number;
    endingEquity: number;
    closedTrades: ClosedTrade[];
}

interface ReplaySession {
    header: ReplaySessionHeader;
    ticks: RecordedMarketTick[];
    filePath: string;
}

const DEFAULT_FEE_RATE = 0.001;
const DEFAULT_SLIPPAGE_RATE = 0.00025;

class ReplayExchange extends Exchange {
    private currentTick: RecordedMarketTick | null = null;
    private baseBalance: number;
    private quoteBalance: number;
    private openPositionQuantity: number;
    private openPositionCostQuote: number;
    private openPositionEntryTime: number | null = null;
    private closedTrades: ClosedTrade[] = [];
    private feesPaidQuote: number = 0;

    constructor(
        private readonly symbol: string,
        private readonly rules: SymbolTradingRules,
        initialBalances: { base: number; quote: number },
        private readonly feeRate: number = DEFAULT_FEE_RATE,
        private readonly slippageRate: number = DEFAULT_SLIPPAGE_RATE
    ) {
        super('', '', 'https://api.binance.com');
        this.baseBalance = initialBalances.base;
        this.quoteBalance = initialBalances.quote;
        this.openPositionQuantity = initialBalances.base;
        this.openPositionCostQuote = 0;
    }

    public primeTrackedPosition(position: ReplaySessionHeader['trackedOpenPosition']) {
        if (!position || position.quantity <= 0) {
            return;
        }

        this.openPositionQuantity = position.quantity;
        this.openPositionCostQuote = position.entryPrice * position.quantity;
        this.openPositionEntryTime = null;
    }

    public setCurrentTick(tick: RecordedMarketTick) {
        this.currentTick = tick;
    }

    public getBaseBalance(): number {
        return this.baseBalance;
    }

    public getQuoteBalance(): number {
        return this.quoteBalance;
    }

    public getClosedTrades(): ClosedTrade[] {
        return this.closedTrades.map((trade) => ({ ...trade }));
    }

    public getFeesPaidQuote(): number {
        return this.feesPaidQuote;
    }

    override async ping(): Promise<boolean> {
        return true;
    }

    override async getSymbolTradingRules(symbol: string): Promise<SymbolTradingRules> {
        return this.rules;
    }

    override async placeMarketBuy(symbol: string, quantity: number) {
        const tick = this.requireTick();
        const requestedQuantity = this.floorQuantity(quantity);
        if (requestedQuantity <= 0) {
            throw new Error('Replay BUY qty <= 0');
        }

        const effectiveMinQty = this.rules.minQty || 0;
        if (effectiveMinQty > 0 && requestedQuantity < effectiveMinQty) {
            throw new Error(`Replay BUY rejected: qty ${requestedQuantity} < minQty ${effectiveMinQty}`);
        }

        const grossNotional = requestedQuantity * tick.price;
        const minNotional = this.rules.minNotional || 0;
        if (minNotional > 0 && grossNotional < minNotional) {
            throw new Error(`Replay BUY rejected: notional ${grossNotional.toFixed(2)} < minNotional ${minNotional.toFixed(2)}`);
        }

        if (grossNotional > this.quoteBalance + 1e-8) {
            throw new Error(`Replay BUY rejected: quote balance ${this.quoteBalance.toFixed(2)} < cost ${grossNotional.toFixed(2)}`);
        }

        const totalBaseCostRate = this.feeRate + this.slippageRate;
        const actualQuantity = this.floorQuantity(requestedQuantity * (1 - totalBaseCostRate));
        if (actualQuantity <= 0) {
            throw new Error('Replay BUY qty after costs <= 0');
        }

        this.quoteBalance = Math.max(this.quoteBalance - grossNotional, 0);
        this.baseBalance += actualQuantity;
        this.openPositionCostQuote += grossNotional;
        this.openPositionQuantity += actualQuantity;
        if (this.openPositionEntryTime == null) {
            this.openPositionEntryTime = tick.time;
        }
        this.feesPaidQuote += grossNotional * totalBaseCostRate;

        return {
            executedQty: requestedQuantity.toString(),
            actualQuantity,
        };
    }

    override async placeMarketSell(symbol: string, quantity: number) {
        const tick = this.requireTick();
        const requestedQuantity = this.floorQuantity(quantity);
        if (requestedQuantity <= 0) {
            throw new Error('Replay SELL qty <= 0');
        }

        const sellQuantity = Math.min(requestedQuantity, this.floorQuantity(this.baseBalance));
        if (sellQuantity <= 0) {
            throw new Error('Replay SELL qty unavailable in wallet');
        }

        const effectiveMinQty = this.rules.minQty || 0;
        if (effectiveMinQty > 0 && sellQuantity < effectiveMinQty) {
            throw new Error(`Replay SELL rejected: qty ${sellQuantity} < minQty ${effectiveMinQty}`);
        }

        const grossProceeds = sellQuantity * tick.price;
        const minNotional = this.rules.minNotional || 0;
        if (minNotional > 0 && grossProceeds < minNotional) {
            throw new Error(`Replay SELL rejected: notional ${grossProceeds.toFixed(2)} < minNotional ${minNotional.toFixed(2)}`);
        }

        const totalQuoteCostRate = this.feeRate + this.slippageRate;
        const netProceeds = grossProceeds * (1 - totalQuoteCostRate);
        const averageCost = this.openPositionQuantity > 0
            ? this.openPositionCostQuote / this.openPositionQuantity
            : tick.price;
        const costOfSold = averageCost * sellQuantity;
        const pnlQuote = netProceeds - costOfSold;

        this.baseBalance = Math.max(this.baseBalance - sellQuantity, 0);
        this.quoteBalance += netProceeds;
        this.feesPaidQuote += grossProceeds * totalQuoteCostRate;

        if (this.openPositionQuantity > 0) {
            this.openPositionQuantity = Math.max(this.openPositionQuantity - sellQuantity, 0);
            this.openPositionCostQuote = Math.max(this.openPositionCostQuote - costOfSold, 0);
        }

        this.closedTrades.push({
            entryTime: this.openPositionEntryTime ?? tick.time,
            exitTime: tick.time,
            quantity: sellQuantity,
            entryPrice: averageCost,
            exitPrice: tick.price,
            pnlQuote,
        });

        if (this.openPositionQuantity <= 0 || this.baseBalance <= 0) {
            this.openPositionQuantity = 0;
            this.openPositionCostQuote = 0;
            this.openPositionEntryTime = null;
        }

        return {
            executedQty: sellQuantity.toString(),
        };
    }

    private floorQuantity(quantity: number): number {
        const stepSize = this.rules.stepSize || 0;
        if (stepSize <= 0) {
            return Math.floor(quantity * 100000) / 100000;
        }

        const precision = this.getPrecision(stepSize);
        const floored = Math.floor((quantity + Number.EPSILON) / stepSize) * stepSize;
        return Number(floored.toFixed(precision));
    }

    private getPrecision(stepSize: number): number {
        const asString = stepSize.toString();
        const decimals = asString.includes('.') ? asString.split('.')[1]!.length : 0;
        return Math.min(decimals, 8);
    }

    private requireTick(): RecordedMarketTick {
        if (!this.currentTick) {
            throw new Error('Replay market snapshot missing');
        }

        return this.currentTick;
    }
}

function resolveReplayFile(filePath?: string | null, useLatest: boolean = false): string {
    if (filePath) {
        return resolve(process.cwd(), filePath);
    }

    if (!useLatest) {
        throw new Error("Aucun fichier replay fourni. Utilise --replay <fichier> ou --replay-latest.");
    }

    const replayDir = getReplayDirectory();
    if (!existsSync(replayDir)) {
        throw new Error(`Aucun dossier replay trouve dans ${replayDir}`);
    }

    const candidates = readdirSync(replayDir)
        .filter((file) => file.endsWith('.jsonl'))
        .map((file) => resolve(replayDir, file))
        .sort((left, right) => {
            const leftName = left.split('/').pop() || left;
            const rightName = right.split('/').pop() || right;
            return rightName.localeCompare(leftName);
        });

    const latest = candidates[0];
    if (!latest) {
        throw new Error(`Aucun fichier replay disponible dans ${replayDir}`);
    }

    return latest;
}

function loadReplaySession(filePath: string): ReplaySession {
    if (!existsSync(filePath)) {
        throw new Error(`Fichier replay introuvable: ${filePath}`);
    }

    const raw = readFileSync(filePath, 'utf-8')
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    if (raw.length === 0) {
        throw new Error(`Fichier replay vide: ${filePath}`);
    }

    const entries = raw.map((line) => JSON.parse(line) as ReplayFileEntry);
    const sessionIndexes = entries
        .map((entry, index) => entry.type === 'session' ? index : -1)
        .filter((index) => index >= 0);

    const inferLegacyHeader = (): ReplaySessionHeader => {
        const fileName = basename(filePath, '.jsonl');
        const match = fileName.match(/^(.*?)-(live|demo)(?:-.+)?$/);
        const symbol = match?.[1] || 'BTCUSDC';
        const mode = (match?.[2] as ReplaySessionHeader['mode']) || 'demo';
        const ticks = entries.filter((entry): entry is RecordedMarketTick => entry.type === 'tick');
        const firstTick = ticks[0];

        if (!firstTick) {
            throw new Error(`Fichier replay vide ou invalide: ${filePath}`);
        }

        Logger.warn(`[Replay] Fichier legacy sans header detecte, valeurs par defaut appliquees -> ${filePath}`);
        return {
            type: 'session',
            version: 1,
            recordedAt: new Date(firstTick.time).toISOString(),
            symbol,
            mode,
            initialBalances: {
                base: 0,
                quote: 25,
            },
            trackedOpenPosition: null,
            exchangeRules: {
                minNotional: 0,
                minQty: 0,
                stepSize: 0,
            },
        };
    };

    const lastSessionIndex = sessionIndexes.at(-1);
    if (lastSessionIndex == null) {
        const header = inferLegacyHeader();
        const ticks = entries.filter((entry): entry is RecordedMarketTick => entry.type === 'tick');
        if (ticks.length === 0) {
            throw new Error(`Fichier replay sans tick: ${filePath}`);
        }

        return {
            header,
            ticks,
            filePath,
        };
    }

    const header = entries[lastSessionIndex] as ReplaySessionHeader;

    const nextSessionIndex = sessionIndexes.find((index) => index > lastSessionIndex) ?? entries.length;
    const ticks = entries
        .slice(lastSessionIndex + 1, nextSessionIndex)
        .filter((entry): entry is RecordedMarketTick => entry.type === 'tick');
    if (ticks.length === 0) {
        throw new Error(`Fichier replay sans tick dans la derniere session: ${filePath}`);
    }

    return {
        header,
        ticks,
        filePath,
    };
}

function getDefaultPreset(header: ReplaySessionHeader): StrategyPreset {
    return {
        maxSpreadPct: 0.05,
        obiThreshold: 0.58,
        obiExitThreshold: 0.38,
        tpMultiplier: 4.2,
        slMultiplier: 2.2,
        minNotional: Math.max(6, header.exchangeRules.minNotional || 0),
        minScore: 8,
    };
}

function buildOptimizationPresets(header: ReplaySessionHeader): StrategyPreset[] {
    const minNotional = Math.max(6, header.exchangeRules.minNotional || 0);
    const spreads = [0.04, 0.05];
    const obiThresholds = [0.56, 0.58, 0.60];
    const obiExits = [0.36, 0.38, 0.40];
    const tpMultipliers = [3.8, 4.2, 4.8];
    const slMultipliers = [1.8, 2.2, 2.6];
    const minScores = [7, 8, 9];
    const presets: StrategyPreset[] = [];

    for (const maxSpreadPct of spreads) {
        for (const obiThreshold of obiThresholds) {
            for (const obiExitThreshold of obiExits) {
                for (const tpMultiplier of tpMultipliers) {
                    for (const slMultiplier of slMultipliers) {
                        for (const minScore of minScores) {
                            presets.push({
                                maxSpreadPct,
                                obiThreshold,
                                obiExitThreshold,
                                tpMultiplier,
                                slMultiplier,
                                minNotional,
                                minScore,
                            });
                        }
                    }
                }
            }
        }
    }

    return presets;
}

async function runSingleReplay(
    session: ReplaySession,
    preset: StrategyPreset,
    initialBalances: { base: number; quote: number }
): Promise<ReplayRunResult> {
    return Logger.runIsolated(() =>
        Tracker.runIsolated(async () => {
            const strategy = new OrderBookScalpingStrategy(
                preset.maxSpreadPct,
                preset.obiThreshold,
                preset.obiExitThreshold,
                preset.tpMultiplier,
                preset.slMultiplier,
                preset.minNotional,
                preset.minScore
            );

            const exchange = new ReplayExchange(
                session.header.symbol,
                session.header.exchangeRules,
                initialBalances
            );

            if (session.header.trackedOpenPosition) {
                Tracker.setOpenPosition(session.header.trackedOpenPosition);
                exchange.primeTrackedPosition(session.header.trackedOpenPosition);
            }

            const firstPrice = session.ticks[0]?.price || 0;
            const initialEquity = initialBalances.quote + initialBalances.base * firstPrice;
            let peakEquity = initialEquity;
            let maxDrawdownPct = 0;

            for (const tick of session.ticks) {
                exchange.setCurrentTick(tick);
                const ctx: TickContext = {
                    balanceBTC: exchange.getBaseBalance(),
                    balanceQuote: exchange.getQuoteBalance(),
                    bids: tick.bids,
                    asks: tick.asks,
                };

                await strategy.onTick(tick.price, exchange, session.header.symbol, ctx);

                const equity = exchange.getQuoteBalance() + exchange.getBaseBalance() * tick.price;
                peakEquity = Math.max(peakEquity, equity);
                if (peakEquity > 0) {
                    const drawdownPct = ((peakEquity - equity) / peakEquity) * 100;
                    maxDrawdownPct = Math.max(maxDrawdownPct, drawdownPct);
                }
            }

            const lastPrice = session.ticks[session.ticks.length - 1]?.price || firstPrice;
            const endingEquity = exchange.getQuoteBalance() + exchange.getBaseBalance() * lastPrice;
            const netPnlQuote = endingEquity - initialEquity;
            const closedTrades = exchange.getClosedTrades();
            const totalTrades = closedTrades.length;
            const winningTrades = closedTrades.filter((trade) => trade.pnlQuote > 0);
            const losingTrades = closedTrades.filter((trade) => trade.pnlQuote <= 0);
            const grossWins = winningTrades.reduce((sum, trade) => sum + trade.pnlQuote, 0);
            const grossLosses = losingTrades.reduce((sum, trade) => sum + Math.abs(trade.pnlQuote), 0);
            const profitFactor = grossLosses > 0
                ? grossWins / grossLosses
                : (grossWins > 0 ? Number.POSITIVE_INFINITY : 0);

            return {
                preset,
                netPnlQuote,
                returnPct: initialEquity > 0 ? (netPnlQuote / initialEquity) * 100 : 0,
                totalTrades,
                winRate: totalTrades > 0 ? (winningTrades.length / totalTrades) * 100 : 0,
                profitFactor,
                maxDrawdownPct,
                feesPaidQuote: exchange.getFeesPaidQuote(),
                endingQuote: exchange.getQuoteBalance(),
                endingBase: exchange.getBaseBalance(),
                endingEquity,
                closedTrades,
            };
        })
    );
}

function formatPreset(preset: StrategyPreset): string {
    return [
        `spread=${preset.maxSpreadPct.toFixed(3)}`,
        `obi=${preset.obiThreshold.toFixed(2)}`,
        `obiExit=${preset.obiExitThreshold.toFixed(2)}`,
        `tp=${preset.tpMultiplier.toFixed(1)}`,
        `sl=${preset.slMultiplier.toFixed(1)}`,
        `score=${preset.minScore}`,
    ].join(' | ');
}

function formatProfitFactor(value: number): string {
    if (!Number.isFinite(value)) {
        return 'inf';
    }

    return value.toFixed(2);
}

function printSingleReplayReport(session: ReplaySession, result: ReplayRunResult) {
    console.log(`Replay file: ${session.filePath}`);
    console.log(`Symbol: ${session.header.symbol} | Mode source: ${session.header.mode}`);
    console.log(`Ticks: ${session.ticks.length} | Recorded at: ${session.header.recordedAt}`);
    console.log(`Preset: ${formatPreset(result.preset)}`);
    console.log(`Net PnL: ${result.netPnlQuote.toFixed(2)} | Return: ${result.returnPct.toFixed(2)}%`);
    console.log(`Win rate: ${result.winRate.toFixed(2)}% | Trades: ${result.totalTrades} | Profit factor: ${formatProfitFactor(result.profitFactor)}`);
    console.log(`Max drawdown: ${result.maxDrawdownPct.toFixed(2)}% | Fees+slippage: ${result.feesPaidQuote.toFixed(2)}`);
    console.log(`Ending equity: ${result.endingEquity.toFixed(2)} | Quote: ${result.endingQuote.toFixed(2)} | Base: ${result.endingBase}`);
}

function printOptimizationReport(session: ReplaySession, baseline: ReplayRunResult, results: ReplayRunResult[]) {
    const topResults = [...results]
        .sort((left, right) => right.netPnlQuote - left.netPnlQuote)
        .slice(0, 5);

    console.log(`Replay file: ${session.filePath}`);
    console.log(`Symbol: ${session.header.symbol} | Ticks: ${session.ticks.length}`);
    console.log(`Baseline -> PnL ${baseline.netPnlQuote.toFixed(2)} | Return ${baseline.returnPct.toFixed(2)}% | DD ${baseline.maxDrawdownPct.toFixed(2)}% | ${formatPreset(baseline.preset)}`);
    console.log(`Top presets:`);

    topResults.forEach((result, index) => {
        console.log(
            `${index + 1}. PnL ${result.netPnlQuote.toFixed(2)} | Return ${result.returnPct.toFixed(2)}% | Win ${result.winRate.toFixed(2)}% | DD ${result.maxDrawdownPct.toFixed(2)}% | PF ${formatProfitFactor(result.profitFactor)} | ${formatPreset(result.preset)}`
        );
    });

    console.log(`Attention: optimise sur un seul fichier = risque d'overfit. Valide toujours sur plusieurs sessions.`);
}

export async function runReplayMode(options: ReplayModeOptions = {}) {
    const replayFile = resolveReplayFile(options.filePath, options.useLatest);
    const session = loadReplaySession(replayFile);
    const initialBalances = {
        base: options.initialBaseOverride ?? session.header.initialBalances.base,
        quote: options.initialQuoteOverride ?? session.header.initialBalances.quote,
    };

    const baselinePreset = getDefaultPreset(session.header);
    const baseline = await runSingleReplay(session, baselinePreset, initialBalances);

    if (!options.optimize) {
        printSingleReplayReport(session, baseline);
        return;
    }

    const presets = buildOptimizationPresets(session.header);
    const results: ReplayRunResult[] = [];

    for (const preset of presets) {
        results.push(await runSingleReplay(session, preset, initialBalances));
    }

    printOptimizationReport(session, baseline, results);
}
