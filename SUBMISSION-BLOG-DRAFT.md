# SuiGuard: A Wallet Companion That Remembers Your Context

Blockchain activity is public, but transaction histories are not always easy to interpret. A list of hashes and object changes rarely explains whether an interaction is part of a user's normal activity or what it meant to them.

An intelligent personal wallet companion that helps Sui users understand their financial activity, recognize familiar transactions and retain useful context across sessions through encrypted, persistent memory.

SuiGuard turns available transaction facts into readable summaries, lets users add their own context, and checks later activity against patterns built from the wallet's loaded history. It does not claim that a transaction is safe or that a similar transaction has the same intent.

## How it works

SuiGuard uses Tatum's Sui gRPC integration to fetch activity and balance data for a connected wallet. It presents facts returned by the chain service—such as the Move action, sender, gas, balance changes, and object changes—separately from generated explanations. When the service omits details, SuiGuard keeps that uncertainty visible instead of inventing a purpose for the transaction.

When a user recognizes an activity, they can save a label and explanation with Walrus Memory. The memory includes transaction evidence such as the verified action and observed asset-flow directions. Content is processed and Seal-encrypted in the browser; embeddings are generated locally, and the delegate key is kept encrypted in browser storage. The backend proxies relayer traffic and keeps the Tatum API key server-side.

On a later activity scan, SuiGuard first looks for an exact transaction memory, then considers related context only when it finds supporting evidence such as a matching sender, verified action, and observed asset flow. The baseline counts repeated activity from the currently loaded history. A match is presented as a similarity to activity the user reviewed—not as a security verdict.

## What the memory changes

Without saved context, SuiGuard can report that a wallet received an asset or called a contract, but it cannot know why that activity is familiar to its owner. With a user-approved memory, a later transaction with a sufficiently similar observed pattern can display the saved explanation. If the evidence is incomplete or differs, SuiGuard leaves the transaction for review.

This is the learning loop: inspect activity, let the user teach the app what it means to them, and use that context in a later session. The user remains in control of the label and explanation.

## Current limits

The baseline covers transactions currently loaded from Tatum and depends on fields returned by the RPC. It is not a complete wallet ledger or an automated fraud detector. Similarity can be imperfect, so SuiGuard shows the evidence it used and keeps uncertain activity reviewable. Wallet-specific Mainnet memory counts and the deployed demo should be verified before publishing this post.

**Project:** SuiGuard  
**Repository:** [add public repository URL]  
**Demo:** [add published demo URL]  
**Walrus Mainnet writes:** [confirm at least 10 in the Walrus Memory dashboard before publishing]
