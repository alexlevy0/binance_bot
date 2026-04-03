import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), '.binance_bot');
const LOGS_FILE = join(DATA_DIR, 'logs.json');

export class Logger {
    public static logs: { timestamp: string, type: string, message: string }[] = [];
    private static initialized = false;
    private static persistenceEnabled = true;
    private static consoleEnabled = true;

    private static createSnapshot() {
        return {
            logs: [...this.logs],
            initialized: this.initialized,
            persistenceEnabled: this.persistenceEnabled,
            consoleEnabled: this.consoleEnabled,
        };
    }

    private static restoreSnapshot(snapshot: ReturnType<typeof Logger.createSnapshot>) {
        this.logs = [...snapshot.logs];
        this.initialized = snapshot.initialized;
        this.persistenceEnabled = snapshot.persistenceEnabled;
        this.consoleEnabled = snapshot.consoleEnabled;
    }

    private static init() {
        if (this.initialized) return;
        this.initialized = true;
        if (!existsSync(DATA_DIR)) {
            mkdirSync(DATA_DIR, { recursive: true });
        }
        if (existsSync(LOGS_FILE)) {
            try {
                const data = JSON.parse(readFileSync(LOGS_FILE, 'utf-8'));
                if (Array.isArray(data)) this.logs = data;
            } catch (e) {
                // ignore parsing errors
            }
        }
    }

    private static save() {
        if (!this.persistenceEnabled) return;
        try {
            writeFileSync(LOGS_FILE, JSON.stringify(this.logs, null, 2));
        } catch (e) {
            // ignore IO errors
        }
    }

    private static addLog(type: string, message: string) {
        this.init();
        this.logs.unshift({ timestamp: new Date().toISOString(), type, message });
        if (this.logs.length > 200) this.logs.pop(); // Keep up to 200 items efficiently
        this.save();
    }

    static info(message: string) {
        this.addLog('INFO', message);
        if (this.consoleEnabled) {
            console.log(`[${new Date().toISOString()}] ℹ️ ${message}`);
        }
    }

    static success(message: string) {
        this.addLog('SUCCESS', message);
        if (this.consoleEnabled) {
            console.log(`[${new Date().toISOString()}] ✅ ${message}`);
        }
    }

    static warn(message: string) {
        this.addLog('WARN', message);
        if (this.consoleEnabled) {
            console.warn(`[${new Date().toISOString()}] ⚠️ ${message}`);
        }
    }

    static error(message: string, error?: any) {
        this.addLog('ERROR', message);
        if (this.consoleEnabled) {
            console.error(`[${new Date().toISOString()}] ❌ ${message}`, error ? error : '');
        }
    }

    public static async runIsolated<T>(fn: () => Promise<T> | T): Promise<T> {
        this.init();
        const snapshot = this.createSnapshot();

        try {
            this.logs = [];
            this.initialized = true;
            this.persistenceEnabled = false;
            this.consoleEnabled = false;
            return await fn();
        } finally {
            this.restoreSnapshot(snapshot);
        }
    }
}
