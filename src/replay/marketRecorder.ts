import { appendFileSync, existsSync, mkdirSync } from "fs";
import { join } from "path";
import { Logger } from "../utils/logger";
import type { ReplaySessionHeader, RecordedMarketTick } from "./types";

const REPLAY_DIR = join(process.cwd(), '.binance_bot', 'replays');

type ReplaySessionInput = Omit<ReplaySessionHeader, 'type' | 'version' | 'recordedAt'>;
type TickInput = Omit<RecordedMarketTick, 'type'>;

export class MarketRecorder {
    private filePath: string | null = null;

    constructor(private enabled: boolean = false) {}

    public isEnabled(): boolean {
        return this.enabled;
    }

    public getCurrentFilePath(): string | null {
        return this.filePath;
    }

    public startSession(input: ReplaySessionInput) {
        if (!this.enabled || this.filePath) {
            return;
        }

        if (!existsSync(REPLAY_DIR)) {
            mkdirSync(REPLAY_DIR, { recursive: true });
        }

        const safeTimestamp = new Date().toISOString().replace(/[:.]/g, '-');
        this.filePath = join(REPLAY_DIR, `${input.symbol}-${input.mode}-${safeTimestamp}.jsonl`);

        const header: ReplaySessionHeader = {
            type: 'session',
            version: 1,
            recordedAt: new Date().toISOString(),
            ...input,
        };

        appendFileSync(this.filePath, `${JSON.stringify(header)}\n`);
        Logger.info(`[Replay] Enregistrement marche actif -> ${this.filePath}`);
    }

    public recordTick(input: TickInput) {
        if (!this.enabled || !this.filePath) {
            return;
        }

        if (input.price <= 0 || input.bids.length === 0 || input.asks.length === 0) {
            return;
        }

        const tick: RecordedMarketTick = {
            type: 'tick',
            ...input,
        };

        appendFileSync(this.filePath, `${JSON.stringify(tick)}\n`);
    }

    public stopSession() {
        if (!this.enabled || !this.filePath) {
            return;
        }

        Logger.info(`[Replay] Session enregistree -> ${this.filePath}`);
        this.filePath = null;
    }
}

export function getReplayDirectory(): string {
    return REPLAY_DIR;
}
