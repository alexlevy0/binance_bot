import { config } from './src/config';
import { Logger } from './src/utils/logger';
import { Exchange } from './src/core/exchange';
import { TradingBot } from './src/bot';
import { HyperScalpingStrategy } from './src/strategies/hyperScalping';
import { startDashboard } from './src/server';

async function main() {
    Logger.info("🚀 Initializing Scalable Binance Spot Trading Bot...");

    const exchange = new Exchange(config.apiKey, config.secretKey, config.baseURL);

    try {
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

        // Initialize the Bot orchestrator
        const bot = new TradingBot(exchange, config.defaultPair, config.pollingIntervalMs);

        // Register the High-Frequency Scalping Strategy ! 🚀
        // Ex: Achete de suite, et revend pour 0.02% de profit, ou coupe à 0.05% de perte
        bot.registerStrategy(new HyperScalpingStrategy(0.001, 1.0002, 0.9995));

        // Boot natively isolated UI Dashboard ⚡
        startDashboard(bot, 3000);

        await bot.start();

        // Catch SIGINT to allow graceful shutdown
        process.on('SIGINT', () => {
            bot.stop();
            process.exit(0);
        });

    } catch (error: any) {
        Logger.error("Fatal initialization error", error);
    }
}

main();