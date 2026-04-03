# binance_bot

To install dependencies:

```bash
bun install
```

To run:

```bash
bun run index.ts
```

To record market snapshots for replay/optimization:

```bash
bun run index.ts --record-market
```

To replay the latest recorded session offline:

```bash
bun run index.ts --replay-latest
```

To replay a specific session and simulate another starting capital:

```bash
bun run index.ts --replay .binance_bot/replays/<file>.jsonl --replay-quote 100
```

To run a small parameter sweep on a recorded session:

```bash
bun run index.ts --replay-latest --optimize
```

This project was created using `bun init` in bun v1.3.5. [Bun](https://bun.com) is a fast all-in-one JavaScript runtime.
