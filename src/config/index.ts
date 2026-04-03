const isLive = process.argv.includes('--live');

export const config = {
    isLive,
    apiKey: isLive ? (process.env.API_KEY || '') : (process.env.API_KEY_DEMO || ''),
    secretKey: isLive ? (process.env.SECRET_KEY || '') : (process.env.SECRET_KEY_DEMO || ''),
    baseURL: isLive ? 'https://api.binance.com' : (process.env.BASE_URL || 'https://testnet.binance.vision'),
    defaultPair: 'BTCUSDC',
    pollingIntervalMs: 1000,
};

if (!config.apiKey || !config.secretKey) {
    const requiredKeys = config.isLive
        ? "API_KEY and SECRET_KEY"
        : "API_KEY_DEMO and SECRET_KEY_DEMO";
    console.error(`❌ ${requiredKeys} must be defined in the .env file.`);
    process.exit(1);
}
