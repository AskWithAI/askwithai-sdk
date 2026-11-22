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
import { AskWithAI, formatReceipt } from "@askwithai/sdk";

const askwithai = new AskWithAI({ apiKey: process.env.ASKWITHAI_API_KEY! });
const d = await askwithai.decide("acme/refund-check", { input: { amount: 42 }, idempotencyKey: orderId });
console.log(formatReceipt(d).join("\n")); // the plain-language summary, three steps, time and cost
```

The `askwithai` command covers the full Decision API — decisions, runtimes, versions, reviews,
learning, templates and privacy — plus a generic `askwithai call <method> <path>` and
`askwithai endpoints` that read the API's own live description, so they work against any
endpoint, including ones added after this package's last release. Run `askwithai help` for the
full list. Start with `askwithai init`, which reads your workspace and prints the next steps for the path you chose in the guided start; `askwithai status <owner/runtime>` prints the runtime's Fast, Accurate and Improving scorecard, and `askwithai compare` tries fast and second-opinion model pairings on the same test cases.

Full documentation — the client's methods, typed decisions with `createDecision`, the faux test server, waiting for input requests, and the `askwithai` command — is published at [askwith.ai](https://askwith.ai).

## License

MIT, see [LICENSE](LICENSE).
