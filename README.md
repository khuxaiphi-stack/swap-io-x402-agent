# Swap.io `x402` Autonomous Portfolio Rebalancer & Non-Custodial Execution Agent

[![Swap.io](https://img.shields.io/badge/Swap.io-Hermes%20x402%20API-00F5A0)](https://swap.io)
[![Hermes Endpoint](https://img.shields.io/badge/Endpoint-hermes.swap.io-blue)](https://hermes.swap.io/v1/info)
[![Protocol](https://img.shields.io/badge/Protocol-HTTP%20402%20%28x402--solana%29-purple)](https://docs.swap.io/developer-tools/agent-api-x402)
[![Interactive 75s Video Player](https://img.shields.io/badge/75s%20Pitch%20Video-Live%20Player-orange)](https://khuxaiphi-stack.github.io/swap-io-x402-agent/)

An open-source **Autonomous Volatility-Triggered Portfolio Rebalancer & Non-Custodial Swap/DCA Agent** powered by the [Swap.io](https://swap.io) **Hermes `x402` Agent API** (`https://hermes.swap.io`).

- 🎬 **Watch the 75-Second Interactive 1080p Storyboard Video Player:** [`https://khuxaiphi-stack.github.io/swap-io-x402-agent/`](https://khuxaiphi-stack.github.io/swap-io-x402-agent/)
- 📄 **Live `HTTP 402` Handshake Trace Captured from `https://hermes.swap.io`:** [`live-hermes-402-trace.json`](./live-hermes-402-trace.json)

---

## 🎬 The 90-Second Pitch: Why AI Agents Need `x402` on Swap.io

### 1. The Scenario: Event-Driven Solana Rebalancer & Tail-Risk Hedger
Imagine an autonomous AI agent managing a Solana treasury (`60% SOL / 40% USDC`). Most of the week, the market trades sideways within a tight range—the agent checks drift every minute and executes **zero swaps**.
Only when volatility spikes and portfolio drift exceeds **3.5%** does the agent wake up to rebalance across **Jupiter, Raydium, Orca, and Meteora** via [Swap.io](https://swap.io).

### 2. How the `x402` Flow Works Step-by-Step (`https://hermes.swap.io`)

```
┌─────────────────────────────────────────────────────────────────────────────┐
│  1. DISCOVER (FREE): GET https://hermes.swap.io/v1/info                     │
│     Returns supported chains (sol), DEX providers, and x402 capabilities    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  2. UNPAID REQUEST: POST https://hermes.swap.io/v1/swap/quote               │
│     Agent requests quote with explicit slippageBps: 30 & providers list     │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  3. HTTP 402 CHALLENGE: Server responds 402 Payment Required                │
│     • maxAmountRequired: "3007" ($0.003007 USDC in atomic units)            │
│     • payTo: BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD                   │
│     • feePayer: 2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4 (sponsored!)   │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  4. PAY & RETRY: Agent signs USDC transfer auth -> retries with X-PAYMENT   │
│     • Receives ranked quotes + X-PAYMENT-RESPONSE on-chain settlement tx    │
└──────────────────────────────────────┬──────────────────────────────────────┘
                                       ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│  5. BUILD & SIGN LOCALLY: POST /v1/swap/build-tx -> GET /v1/swap/status     │
│     • Agent receives base64 VersionedTransaction, signs locally (keys never │
│       leave agent enclave), broadcasts, and polls status.                   │
└─────────────────────────────────────────────────────────────────────────────┘
```

### 3. Why `x402` Beats API Keys & Monthly Subscriptions

| Dimension | Traditional SaaS API Keys ($99–$299/mo) | Swap.io `x402` Agent API (`hermes.swap.io`) |
| :--- | :--- | :--- |
| **Onboarding Friction** | Human email signup, KYC, credit card, API key rotation | **Zero registration** — any agent with a Solana wallet & USDC can call immediately |
| **Idle Market Cost** | Burns **$99+/month** even when the agent executes 0 trades | **$0.00 when idle** — pays **~$0.003 USDC** only when a swap/quote is actually needed |
| **Parameter-Aware Pricing** | Rigid tier limits & overage penalties | **Smart discounts** — passing explicit `slippageBps` and `providers` lowers per-call price |
| **Failed Request Protection** | Counted against rate limits/quotas | **Zero charge on failed requests** — settled only when the request succeeds |
| **Custody & Gas** | Often requires custodial deposits or SOL gas management | **100% Non-Custodial** + facilitator (`2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4`) sponsors SOL gas for the `x402` USDC payment |

---

## 🚀 Quickstart & Live Demo

### 1. Run Automated Unit Tests
```bash
npm test
# or directly with Node.js 20+:
node --test test/x402-agent.test.mjs
```

### 2. Run Live Discovery & `HTTP 402` Handshake Against `https://hermes.swap.io`
```bash
node src/live-demo.mjs
```
