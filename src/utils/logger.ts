import { existsSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

const DATA_DIR = join(process.cwd(), '.binance_bot');
const LOGS_FILE = join(DATA_DIR, 'logs.json');

export class Logger {
    public static logs: { timestamp: string, type: string, message: string }[] = [];
    private static initialized = false;

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
        console.log(`[${new Date().toISOString()}] ℹ️ ${message}`);
    }

    static success(message: string) {
        this.addLog('SUCCESS', message);
        console.log(`[${new Date().toISOString()}] ✅ ${message}`);
    }

    static warn(message: string) {
        this.addLog('WARN', message);
        console.warn(`[${new Date().toISOString()}] ⚠️ ${message}`);
    }

    static error(message: string, error?: any) {
        this.addLog('ERROR', message);
        console.error(`[${new Date().toISOString()}] ❌ ${message}`, error ? error : '');
    }
}
