# SuiGuard Project Brief

**Purpose:** Give an independent reviewer enough concrete information to judge whether SuiGuard matches the Tatum × Walrus Total Recall hackathon brief. This document describes the implementation and its limits; it is not a claim that all submission requirements have been completed.

## One-sentence pitch

SuiGuard helps Sui users interpret wallet activity, recognize familiar interactions, and recall encrypted context they chose to save.

## Problem and intended user

Sui transaction histories expose hashes, Move calls, balance changes, gas, and object changes, but those records can be difficult for everyday wallet users to interpret. A user may also remember why an earlier activity was familiar while the application does not.

SuiGuard is for Sui wallet users who want readable context around their wallet activity. It is not a wallet, transaction signer for asset transfers, auditor, or fraud detector.

## Main user journey

1. The user connects a Sui wallet or enters a public address and fetches activity.
2. SuiGuard requests wallet activity and balances through its server-side Tatum Sui integration.
3. It presents returned facts separately from generated plain-language summaries.
4. The user labels an activity as familiar, unfamiliar, or misunderstood and may add an explanation and known app.
5. After the user sets up Walrus Memory, SuiGuard saves the user-approved context and recalls it for exact or sufficiently supported related activity.
6. A repeated-activity baseline summarizes behavior among currently loaded successful transactions. If evidence is incomplete or does not match, the activity stays available for review.

## What is implemented

- Sui wallet connection with the selected public address filled into the activity search; manual public-address entry is available as a read-only fallback.
- Tatum Sui gRPC activity queries, pagination, balances, transaction facts, and object-change details as returned by the service.
- Human-readable explanations for recognized transfers and contract activity, while retaining raw transaction facts for inspection.
- The activity feed labels app-generated explanations separately from Tatum-returned evidence, and labels remembered context by its origin: just saved, restored from this browser's encrypted cache, or actually recalled from Walrus.
- User-selected transaction labels and explanations.
- Walrus Memory account setup and delegate registration through wallet-approved SDK flows.
- Browser-side local MiniLM embedding generation and Seal encryption for memory content. The delegate key is encrypted in browser IndexedDB and scoped to wallet/network. The backend proxies relayer calls and keeps the Tatum API key server-side.
- Memory recall for the exact transaction and related activity only when concrete evidence supports it, such as a same sender and verified Move action with matching observed balance/object flows. Swap matching can allow different reported Move calls when the sender and observed input/output asset directions match.
- A wallet/network-scoped activity baseline requiring at least two observations before an activity is called repeated. It reports observations and approximate spacing where timestamps exist.
- The baseline dashboard separately counts familiar context, repeated activity, and transactions with insufficient comparison evidence; each transaction's baseline note explains the sample size and observed anchors.
- The Walrus Memory view records in-session write/recall operations as pending, confirmed, failed, or no-match, with network, transaction, and full blob references when returned. This is an operation log for this browser session, not a full account-wide memory inventory or proof of a required write count.
- After loading a cached context, the bounded activity recall still queries Walrus for recent candidate transactions. A per-transaction **Verify with Walrus** action also performs a fresh SDK recall and only marks it recalled after the result passes wallet, network, and relevance checks.
- Onboarding describes why the public address is requested, which chain information remains public, what user context is encrypted for Walrus, and the scope of disconnecting the current browser session.
- Activity pagination: 20 initially visible, then 10 additional activities; baseline rows are paginated five at a time. These controls are not shown in the Walrus Memories view.
- The header's “Contexts loaded” count reflects memory records known to this SuiGuard browser session/profile. It is not a count of every write in the owner's Walrus Memory account; use the Walrus dashboard for the hackathon's 10+ Mainnet-write verification.
- Explicit review states for unmatched or insufficiently described activity; no safety score or fraud claim.

## Integration and data flow

**Tatum:** The Express server holds the Tatum API key and queries Tatum's Sui gRPC interface for activity and balance data. The browser calls the app's `/api/tatum/*` endpoints. The app does not place the Tatum key in frontend code.

**Walrus Memory:** The browser uses `MemWalManual`. Memory text and search vectors are processed in the browser; the memory content is Seal-encrypted before being sent through the app's relayer proxy. The delegate private key is not sent to the backend. The user's wallet is used for account/delegate authorization and any required protected-memory access approval.

**Frontend/backend:** React, TypeScript, Vite, and Express run from one Node server. The Express app proxies Tatum and Walrus Memory requests; the browser owns the wallet session, local embedding work, encryption, and encrypted delegate profile.

## Privacy and security boundaries

- Sui addresses and chain activity are public.
- SuiGuard does not ask for wallet private keys or recovery phrases.
- Fetching activity does not require a wallet signature. Walrus account setup/delegate registration can require wallet transaction approvals; protected-memory access may require a signed message.
- The app does not request a transaction that transfers the user's assets. Setup operations may still use gas.
- Memory contents are encrypted client-side before they reach the relayer. The namespace and public onchain ownership/blob metadata should not be treated as private.
- Saved memory contains the user label and note together with transaction anchors used to find relevant future activity. Those fields are encrypted before they reach the relayer; the underlying Sui activity remains public.
- Encrypted delegate credentials are stored in this browser. A new browser/device or cleared site data may require registering a new delegate. Browser storage does not protect against malicious code running on the same origin.

## Limits and behavior to describe honestly

- The baseline is computed from transactions currently loaded for the wallet, not a complete lifetime ledger. Tatum's indexed history may have scan-budget and earliest-checkpoint limits.
- Cross-session persistence is presented with separate provenance for the encrypted browser cache and Walrus recall. To demonstrate a Walrus recall, use the per-transaction verification action and show the returned blob reference; a browser-cache restore alone is not remote-recall proof.
- Transaction explanations depend on Tatum's returned fields. Unknown contract behavior is not inferred as certain.
- Amount comparisons use observed wallet balance changes; SUI changes can include gas and other effects. Token decimals may be unavailable.
- “Matches a saved pattern” means the observed data resembles activity the user previously labeled. It does not establish identical intent, safety, or legitimacy.
- Walrus recall is bounded per fetch. Live wallet-specific verification of 10+ Mainnet writes must be checked by the owner in the Walrus Memory dashboard.

## Verification status

- Repository tests: **23 passing** at the last test run.
- TypeScript check: **passed** at the last check.
- Production build: **passed**; Rollup emits an existing comment-annotation warning from `@scure/base`.
- The app and user-validated Sui wallet flows have been exercised locally in the development environment.
- The 10+ successful Mainnet write count, public repository visibility, hosted deployment URL, published demo, blog post, and official submission receipt are external/account-specific checks and are not verified by this brief.

## Hackathon fit

SuiGuard's intended track is **Consumer Finance Apps**. Its core fit is a personal wallet companion that learns from user-approved labels and reuses that context later. The clearest Walrus Memory demonstration is to label an activity, then show a later supported match displaying that saved explanation. The Tatum integration supplies the onchain facts used to build and compare the activity patterns.

The published event criteria assign 30% to Walrus/Tatum integration, 30% to technical quality, 20% to creativity, and 20% to presentation. The event checklist also calls for Mainnet Walrus Memory integration, at least 10 Mainnet writes, a working demo, a public repository, and a published blog post explaining what the app does, how Tatum and Walrus are used, and how it learns over time. Verify those requirements against the current official event page before submission: <https://recall-tatum-walrus.vercel.app/>.

---

## Copyable independent-review prompt

```text
You are an independent hackathon reviewer. Evaluate whether the project below is a convincing implementation of the Tatum × Walrus Total Recall brief, especially the Consumer Finance Apps track and the goal of building an app that remembers and improves across sessions.

Assess:
1. Whether the product pitch matches what is actually implemented.
2. Whether Tatum and Walrus Memory are integrated meaningfully and technically, rather than added as superficial requirements.
3. Whether the memory loop visibly changes the later user experience.
4. The project's strongest differentiators and its most important weaknesses for judging.
5. Any claims that are unsupported, misleading, or need clearer proof in the demo.
6. The five highest-impact improvements possible before submission, ordered by value and effort.

Be candid and specific. Separate facts stated in the brief from your assumptions. Do not assume the app understands every contract, has complete wallet history, guarantees a match is correct, has 10+ Mainnet writes, is publicly deployed, or has been submitted; those account-specific/external requirements are explicitly unverified unless evidence is supplied. Do not invent hackathon criteria. If the provided information is insufficient to judge a point, identify the missing evidence.

Project brief:
[Paste the contents of PROJECT-BRIEF.md here, or attach the file.]
```
