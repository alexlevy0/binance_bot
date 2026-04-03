function hasArg(flag: string): boolean {
    return process.argv.includes(flag);
}

function getArgValue(flag: string): string | null {
    const equalsArg = process.argv.find((arg) => arg.startsWith(`${flag}=`));
    if (equalsArg) {
        return equalsArg.slice(flag.length + 1);
    }

    const index = process.argv.indexOf(flag);
    if (index === -1) {
        return null;
    }

    const nextArg = process.argv[index + 1];
    if (!nextArg || nextArg.startsWith('--')) {
        return null;
    }

    return nextArg;
}

function getNumberArg(flag: string): number | null {
    const rawValue = getArgValue(flag);
    if (rawValue == null) {
        return null;
    }

    const parsed = Number(rawValue);
    return Number.isFinite(parsed) ? parsed : null;
}

const isLive = hasArg('--live');
const replayFile = getArgValue('--replay');
const replayLatest = hasArg('--replay-latest');
const isReplay = replayLatest || replayFile !== null;

export const config = {
    isLive,
    isReplay,
    apiKey: isLive ? (process.env.API_KEY || '') : (process.env.API_KEY_DEMO || ''),
    secretKey: isLive ? (process.env.SECRET_KEY || '') : (process.env.SECRET_KEY_DEMO || ''),
    baseURL: isLive ? 'https://api.binance.com' : (process.env.BASE_URL || 'https://testnet.binance.vision'),
    defaultPair: 'BTCUSDC',
    pollingIntervalMs: 1000,
    recordMarketData: hasArg('--record-market'),
    optimizeReplay: hasArg('--optimize'),
    replayFile,
    replayLatest,
    replayQuoteOverride: getNumberArg('--replay-quote'),
    replayBaseOverride: getNumberArg('--replay-base'),
};

if (!config.isReplay && (!config.apiKey || !config.secretKey)) {
    const requiredKeys = config.isLive
        ? "API_KEY and SECRET_KEY"
        : "API_KEY_DEMO and SECRET_KEY_DEMO";
    console.error(`❌ ${requiredKeys} must be defined in the .env file.`);
    process.exit(1);
}
