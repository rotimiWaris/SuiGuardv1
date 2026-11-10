# SuiGuard

Sui wallet activity, explained with personal context that can be saved and recalled across sessions.

SuiGuard is an informational companion, not an auditor or security scanner. It never asks for a wallet private key or seed phrase. Walrus Memory uses a separate delegate key and may ask the connected wallet to approve account setup, delegate registration, or a Seal access message. SuiGuard does not request transactions that transfer the user's assets; setup transactions may still use gas.

---

## Core Features

- **Public Wallet Activity Inspection**: Connect a Sui wallet to fill its public address or enter an address manually; queries Sui gRPC for transactions indexed as affecting the selected address, plus native SUI and coin balances. Wallet connection does not request transaction signatures.
- **Explainable Transactions**: Clearly separates verified onchain facts (gas used, package, module, function, object changes) from app-generated summaries.
- **User-Approved Labeling & Context**: Lets users label transactions as *familiar*, *unfamiliar*, or *misunderstood*, specify known applications, and provide plain-language explanations.
- **Walrus Memory**: Creates or connects a wallet-owned account, generates and registers a delegate through wallet-approved SDK transactions, then uses the official `MemWalManual` client to encrypt memory content with Seal in the browser and retrieve relevant context later. Embeddings are generated locally without a provider API key.
- **Review Queue**: Surfaces unlabeled transactions needing user review.
- **Wallet Activity Baseline**: Builds wallet- and network-scoped patterns from repeated successful activity in the currently loaded Tatum history. Transfers are grouped by direction, reported asset, and counterparty; contract calls require the same verified module/function and sender. A behavior needs at least two observations before it is called repeated. The UI reports sample size and approximate timing where timestamps are available.
- **Paginated Activity Views**: Shows the 20 newest loaded activities first and reveals 10 more at a time. When all currently loaded activity is visible, the same activity-only control can request another Tatum page. Personal baseline patterns are paged five at a time; neither pagination control appears in the Walrus Memories view.
- **Filtering & Insights**: Filter by label, token, and status with an observed "What changed?" summary derived strictly from inspected transaction blocks.

---

## Architecture & Integration Layers

```
┌────────────────────────────────────────────────────────┐
│                   SuiGuard Frontend                    │
│   (React + TypeScript + Tailwind TDS Token System)     │
└───────────────────────────┬────────────────────────────┘
                            │ /api/tatum/*
┌───────────────────────────▼────────────────────────────┐
│                    Express Backend                     │
│  - Tatum Sui Gateway Integration Layer                 │
│  - Walrus Memory relayer proxy                          │
└──────────────┬───────────────────────────┬─────────────┘
               │                           │
  Tatum Sui gRPC                      Walrus Memory
  (activity, balances, objects)        (encrypted writes, recall)
```

The Walrus Memory SDK, local embedding model, Seal encryption, and delegate key handling run in the browser. The Express route proxies relayer requests; it does not receive the delegate private key or plaintext memory content.

---

## Environment Variables & Setup

Use Node.js 20.6 or newer. Create `.env` from the example in the project root. In PowerShell:

```powershell
Copy-Item .env.example .env
```

On macOS/Linux:

```sh
cp .env.example .env
```

Configure the following variables:

| Variable | Description | Default |
|---|---|---|
| `TATUM_API_KEY` | Your Tatum API Key (Mainnet or Testnet) | *(Required)* |
| `TATUM_API_BASE` | Tatum API origin | `https://api.tatum.io` |
| `SUI_NETWORK` | Network target (`mainnet` or `testnet`) | `mainnet` |
| `PORT` | Local server port | `3000` |

`TATUM_API_KEY` is read by the server and must never be added to frontend code or committed. `.env` is excluded by `.gitignore`; `.env.example` contains placeholders only. Set the server's `SUI_NETWORK` to the same network selected in the connected wallet.

### Starting the Application

```bash
npm install
npm run dev
```

Visit the application at `http://localhost:3000`.

Run the local verification commands before a release:

```sh
npm test
npm exec -- tsc --noEmit
npm run build
```

---

## Privacy & Safety Model

1. **Public Wallet Addresses Only**: Accepts public `0x...` addresses through wallet connection or manual entry. Activity lookup does not require a wallet signature. Walrus Memory setup and protected-memory recall can request wallet approvals/signatures; no private keys or seed phrases are requested.
2. **Public Onchain Data**: Clearly notes that all onchain activity is public.
3. **No Speculative Safety Scores**: Avoids unfounded safety percentages, fraud alerts, or guarantees. Unlabeled items are marked "unfamiliar to you" or "not yet labeled".
4. **Explicit Provenance**: Clearly distinguishes between verified onchain facts, user-provided labels, and generated summaries.
5. **Memory**: A browser-local MiniLM model creates search vectors; memory content is Seal-encrypted in the browser before the relayer receives it. No embedding API key is required. Delegate private keys are encrypted with a browser-managed, non-extractable Web Crypto key and stored in IndexedDB, scoped to wallet and network. They are never sent to the backend.

---

## End-to-End Memory Demo

1. Connect the Sui wallet that should own the Walrus Memory account, fetch its activity, and open the Memory Hub. Leave the existing-account field blank for first-time setup. For an account already created through the dashboard, enter its account object ID.
2. Select **Set up Walrus Memory** and approve the account creation and delegate registration prompts in the wallet. Existing accounts need delegate registration approval. SuiGuard generates the delegate key locally; users do not provide a delegate key or embedding API key.
3. Open one transaction, choose a label, add a specific explanation, and save. A save is shown as confirmed only when Walrus Memory returns a blob ID.
4. Confirm the transaction displays the saved context and its Walrus blob ID. This is the immediate confirmation for the write; the Walrus Memory dashboard is the source for checking Mainnet write counts.
5. To demonstrate learning across transactions, label a SUI-to-USDC swap, then repeat the same swap from the same wallet. SuiGuard matches the observed asset directions (SUI decreasing and USDC increasing), even if Tatum reports a different Move call for the repeat transaction. A reverse swap or a different token pair should not inherit the label. The activity card keeps the generated on-chain summary separate from the recalled, user-provided context.
6. After first setup, reconnect the same wallet and SuiGuard restores its encrypted browser profile automatically. The profile is device/browser-local, so a new browser or cleared site data requires setting up a delegate again. Disconnecting memory keeps the profile; deleting browser site data removes it. The account owner can revoke the delegate on chain.
7. Before submission, verify at least 10 successful Mainnet writes in the Walrus Memory dashboard. This is a live-account check and must be completed by the wallet owner.

For the Mainnet demo, keep the wallet on Mainnet. Setup and memory writes require wallet authorization and may incur network or service costs. Never share the wallet recovery phrase in a demo recording.

---

## Demo Run of Show (about 2 minutes)

1. **Show the live data source.** Connect the Sui wallet, confirm the selected network, and fetch activity. Point out that SuiGuard displays Tatum-returned transaction facts separately from generated explanations.
2. **Teach one useful detail.** Open a representative transaction, add a concise user-approved label and explanation, then save it. Show the confirmed Walrus Memory result and blob ID.
3. **Show memory changing the product.** Use a later transaction with the same interaction pattern. Show the recalled label and the evidence SuiGuard used (for example, the same verified action and observed asset-flow directions). If the evidence differs or is incomplete, show that SuiGuard asks for review instead of claiming a match.
4. **Explain limits honestly.** Mention that comparisons cover currently loaded Tatum history and available fields; a match means similar observed behavior, not that an activity is safe or has the same intent.

Avoid recording private wallet information, recovery phrases, or API keys. Use a wallet/account prepared for the demo, and verify the browser's Walrus profile and Mainnet memory writes before recording.

## Hackathon Submission Checklist

- [x] Tatum Sui RPC is used for wallet activity and balance data.
- [x] Walrus Memory writes and recall are integrated; transaction context is encrypted in the browser.
- [x] README documents setup, configuration, privacy boundaries, limitations, and a repeatable demo flow.
- [ ] Verify at least 10 successful Walrus Memory writes on Mainnet in the dashboard.
- [ ] Record and publish the working demo.
- [ ] Publish a blog post explaining the product, its Tatum and Walrus integration, and how saved memory changes later explanations.
- [ ] Confirm the repository is public and provide its URL in the submission.
- [ ] Submit through the official hackathon form before its deadline.

The checkboxes above distinguish implemented project capabilities from account-specific or external submission steps. A source tree alone cannot verify the live Walrus dashboard, public repository access, published demo/blog, or submission receipt.

---

## Known Limitations

- Activity uses Sui gRPC's indexed `affectedAddress` filter, which includes transactions where the address was involved in object or balance effects. It is not a complete raw ledger export. Results are newest first, paged in batches of up to 50, and the interface loads at most 10 pages (500 transactions) per search. Tatum may stop an individual filtered scan at its service scan budget; a continuation cursor is provided when more results can be requested.
- The personal activity baseline is recalculated from currently loaded transactions and does not claim complete wallet history. Missing counterparty or asset fields prevent a transfer comparison. Amount comparisons use observed wallet SUI balance deltas, which can include gas and other balance effects; they are not presented as exact transfer amounts. “Repeated” means seen more than once, not safe or approved.
- Balance and owned-object summaries currently read only their first page (up to 50 balance types or objects). The transaction view reports only fields returned by the gRPC read mask; unavailable status, timestamps, balance changes, or object details remain marked or omitted.
- Walrus Memory setup requires a connected Sui wallet on the matching network. The SDK creates new accounts and registers delegates; SuiGuard discovers existing accounts through the relayer's public owner lookup endpoint. The delegate credential is encrypted in browser IndexedDB for convenience, but browser storage is not a substitute for protection against malicious same-origin scripts. A new browser/device or cleared site data requires setup again.
- The first local embedding may download the quantized MiniLM model in the browser. SuiGuard uses its own namespace for this model's vectors; other embedding models are not compatible with those vectors.
- Recall is attempted for up to 10 transactions per fetched activity page to keep relayer requests bounded. Similarity matches are filtered before their saved context is shown.
- Network throughput is subject to Tatum RPC plan limits. If a 429 rate limit is encountered, a retry delay is observed.
