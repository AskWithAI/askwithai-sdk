# @askwithai/sdk

Call [AskWithAI](https://askwith.ai) Decision Runtimes from your app: a typed client, `createDecision`, a faux server for tests (`@askwithai/sdk/testing`), and the `askwithai` command.

## Install

```bash
pnpm add @askwithai/sdk
# or: npm install @askwithai/sdk
```

Node 22 or later.

## Quick example

```ts
import { AskWithAI } from "@askwithai/sdk";

const askwithai = new AskWithAI({ apiKey: process.env.ASKWITHAI_API_KEY! });
const d = await askwithai.decide("acme/refund-check", { input: { amount: 42 }, idempotencyKey: orderId });
```

Full documentation — the client's methods, typed decisions with `createDecision`, the faux test server, waiting for input requests, and the `askwithai` command — is published at [askwith.ai](https://askwith.ai).

## License

MIT, see [LICENSE](LICENSE).
