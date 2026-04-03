import { config } from './src/config';
import { Logger } from './src/utils/logger';
import { Exchange } from './src/core/exchange';
import { TradingBot } from './src/bot';
import { OrderBookScalpingStrategy } from './src/strategies/orderBookScalping';
import { startDashboard } from './src/server';

function getAuthTroubleshootingHint() {
    if (config.isLive) {
        return "Mode LIVE detecte. Verifie que API_KEY/SECRET_KEY correspondent a de vraies cles Binance Spot live, qu'elles ne sont pas des cles testnet, que l'acces API Spot est actif, et qu'aucune restriction IP ne bloque ta machine.";
    }

    return "Mode DEMO detecte. Verifie que API_KEY_DEMO/SECRET_KEY_DEMO viennent bien du testnet Binance Spot et que BASE_URL pointe vers le testnet.";
}

async function main() {
    Logger.info(`🚀 Initializing Scalable Binance Spot Trading Bot in ${config.isLive ? '🔴 LIVE' : '🟢 DEMO'} mode...`);

    const exchange = new Exchange(config.apiKey, config.secretKey, config.baseURL);

    try {
        const isConnected = await exchange.ping();
        if (!isConnected) {
            Logger.error(`Cannot initialize bot, Binance API is unreachable at ${config.baseURL}`);
            return;
        }

        // Check initial Balances
        const balances = await exchange.getBalances();
        if (balances.length === 0) {
            Logger.info("No non-zero balances found.");
        } else {
            Logger.info(`Found ${balances.length} assets with balance.`);
            balances.forEach((b: any) => {
                console.log(`  - ${b.asset}: ${b.free} (Free)`);
            });
        }

        // Initialize the Bot orchestrator (now WebSocket-driven, no polling interval needed)
        const bot = new TradingBot(exchange, config.defaultPair);

        // Register the Order Book Microstructure Strategy 📊
        // Analyse le carnet d'ordres en temps réel (OBI, Spread, EMA) pour des entrées intelligentes
        bot.registerStrategy(new OrderBookScalpingStrategy());

        // Boot natively isolated UI Dashboard ⚡
        startDashboard(bot, 3000);

        await bot.start();

        // Periodic price logging (every 5s to avoid spam)
        setInterval(() => {
            if (bot.latestPrice > 0) {
                Logger.info(`${config.defaultPair} Price: $${bot.latestPrice.toLocaleString()} | BTC: ${bot.balanceBTC} | USDC: $${bot.balanceQuote.toFixed(2)}`);
            }
        }, 5000);

        // Catch SIGINT to allow graceful shutdown
        process.on('SIGINT', () => {
            bot.stop();
            process.exit(0);
        });

    } catch (error: any) {
        const details = exchange.getErrorDetails(error);

        if (details.isAuthError) {
            const suffix = details.code != null ? ` (status ${details.status ?? 'n/a'}, code ${details.code})` : ` (status ${details.status ?? 'n/a'})`;
            Logger.error(`Binance authentication failed${suffix}`, details.message);
            Logger.warn(getAuthTroubleshootingHint());
            Logger.info(`Startup stopped before trading. Endpoint: ${config.baseURL}`);
            return;
        }

        const suffix = details.code != null ? ` (status ${details.status ?? 'n/a'}, code ${details.code})` : ` (status ${details.status ?? 'n/a'})`;
        Logger.error(`Fatal initialization error${suffix}`, details.message);
    }
}

main();
