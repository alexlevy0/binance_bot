export const config = {
    apiKey: process.env.API_KEY_DEMO || '',
    secretKey: process.env.SECRET_KEY_DEMO || '',
    baseURL: process.env.BASE_URL || 'https://testnet.binance.vision',
    defaultPair: 'BTCUSDT',
    pollingIntervalMs: 2000,
};

if (!config.apiKey || !config.secretKey) {
    console.error("❌ API_KEY_DEMO and SECRET_KEY_DEMO must be defined in the .env file.");
    process.exit(1);
}
