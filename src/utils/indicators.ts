/**
 * Calculates the Relative Strength Index (RSI) using Wilder's Smoothing Method.
 * @param closes Array of historical closing prices
 * @param period RSI period (typically 14)
 * @returns The calculated RSI value, or 50 if there's not enough data
 */
export function calculateRSI(closes: number[], period: number = 14): number {
    if (closes.length <= period) {
        return 50; // Neutral if not enough data
    }

    let gains = 0;
    let losses = 0;

    // Initial average gain/loss over the lookback period
    for (let i = 1; i <= period; i++) {
        const diff = closes[i]! - closes[i - 1]!;
        if (diff >= 0) {
            gains += diff;
        } else {
            losses -= diff;
        }
    }

    let avgGain = gains / period;
    let avgLoss = losses / period;

    if (avgLoss === 0) return 100;

    let rs = avgGain / avgLoss;
    let rsi = 100 - (100 / (1 + rs));

    // Smoothed averages for the remaining data points
    for (let i = period + 1; i < closes.length; i++) {
        const diff = closes[i]! - closes[i - 1]!;
        let gain = diff >= 0 ? diff : 0;
        let loss = diff < 0 ? -diff : 0;

        avgGain = (avgGain * (period - 1) + gain) / period;
        avgLoss = (avgLoss * (period - 1) + loss) / period;

        if (avgLoss === 0) {
            rsi = 100;
        } else {
            rs = avgGain / avgLoss;
            rsi = 100 - (100 / (1 + rs));
        }
    }

    return rsi;
}
