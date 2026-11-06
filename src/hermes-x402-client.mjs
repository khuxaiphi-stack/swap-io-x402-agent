/**
 * Swap.io Hermes Agent API (x402) SDK Client
 * Base URL: https://hermes.swap.io
 *
 * Implements the HTTP 402 Payment Required ("x402") micropayment lifecycle:
 *  1. GET  /v1/info                  (Free capability & provider discovery)
 *  2. POST /v1/swap/quote            (x402 Paid — returns multi-provider ranked quotes)
 *  3. POST /v1/swap/build-tx         (x402 Paid — returns unsigned base64 VersionedTransaction)
 *  4. POST /v1/swap/submit-tx        (x402 Optional Paid broadcast)
 *  5. GET  /v1/swap/status           (Confirmation polling)
 *  6. POST /v1/orders/limit/create   (x402 Paid conditional limit/stop-loss/bracket order)
 *  7. POST /v1/orders/dca/create     (x402 Paid automated DCA order slices)
 */

export const HERMES_BASE_URL = 'https://hermes.swap.io';

export const SOLANA_TOKENS = {
  SOL: {
    mint: 'So11111111111111111111111111111111111111112',
    decimals: 9,
    symbol: 'SOL',
  },
  USDC: {
    mint: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    decimals: 6,
    symbol: 'USDC',
  },
  JUP: {
    mint: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    decimals: 6,
    symbol: 'JUP',
  },
};

export class HermesX402Client {
  /**
   * @param {object} options
   * @param {string} [options.baseUrl='https://hermes.swap.io']
   * @param {function(object): Promise<string>} [options.paymentSigner] - Callback that takes an x402 payment requirement object and returns the base64 X-PAYMENT header payload
   * @param {typeof fetch} [options.fetchImpl=globalThis.fetch]
   */
  constructor({ baseUrl = HERMES_BASE_URL, paymentSigner, fetchImpl = globalThis.fetch } = {}) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
    this.paymentSigner = paymentSigner;
    this.fetchImpl = fetchImpl;
    this.paymentLedger = [];
  }

  /**
   * Free discovery endpoint: GET /v1/info
   */
  async getInfo() {
    const res = await this.fetchImpl(`${this.baseUrl}/v1/info`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return res.json();
  }

  /**
   * Confirmation status polling: GET /v1/swap/status?chainKey=sol&id={txHash}
   */
  async getSwapStatus({ chainKey = 'sol', txHash }) {
    const url = `${this.baseUrl}/v1/swap/status?chainKey=${encodeURIComponent(chainKey)}&id=${encodeURIComponent(txHash)}`;
    const res = await this.fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    return res.json();
  }

  /**
   * Core x402 Pay-and-Retry Executor:
   *  Step A: Send initial unpaid HTTP request to Hermes endpoint.
   *  Step B: If status === 402, parse the x402 PaymentRequirements challenge.
   *  Step C: Authorize atomic USDC micropayment via `paymentSigner` (zero SOL gas required by payer).
   *  Step D: Retry the exact request with `X-PAYMENT` header and record `X-PAYMENT-RESPONSE` settlement proof.
   */
  async requestWithX402(path, body) {
    const url = `${this.baseUrl}${path}`;

    // 1. Initial Unpaid Request
    const initialRes = await this.fetchImpl(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body),
    });

    if (initialRes.status !== 402) {
      const data = await initialRes.json().catch(() => ({}));
      return { status: initialRes.status, paid: false, data };
    }

    // 2. Parse HTTP 402 Challenge
    const challengeBody = await initialRes.json().catch(() => ({}));
    const requirement =
      (Array.isArray(challengeBody.accepts) && challengeBody.accepts[0]) ||
      challengeBody.paymentRequirements ||
      challengeBody;

    if (!this.paymentSigner) {
      return {
        status: 402,
        paid: false,
        x402Challenge: challengeBody,
        requirement,
      };
    }

    // 3. Construct Signed Atomic USDC Payment Payload (X-PAYMENT)
    const xPaymentHeader = await this.paymentSigner(requirement, { path, body });

    // 4. Retry Request with X-PAYMENT Header
    const paidRes = await this.fetchImpl(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
        'X-PAYMENT': xPaymentHeader,
      },
      body: JSON.stringify(body),
    });

    const settlementHeader =
      paidRes.headers?.get?.('x-payment-response') ||
      paidRes.headers?.get?.('X-PAYMENT-RESPONSE') ||
      null;
    const data = await paidRes.json().catch(() => ({}));

    const ledgerEntry = {
      timestamp: new Date().toISOString(),
      endpoint: path,
      maxAmountRequiredAtomicUsdc: requirement.maxAmountRequired || '1000',
      usdcCost: Number(requirement.maxAmountRequired || 1000) / 1e6,
      payTo: requirement.payTo || null,
      settlementHeader,
      httpStatus: paidRes.status,
    };
    this.paymentLedger.push(ledgerEntry);

    return {
      status: paidRes.status,
      paid: paidRes.ok,
      settlementHeader,
      ledgerEntry,
      data,
    };
  }

  /**
   * Paid Quote Endpoint: POST /v1/swap/quote
   * Includes parameter-aware cost optimization: passing explicit `slippageBps` and `providers`
   * lowers server routing overhead and reduces the x402 per-call quote price.
   */
  async getQuote({
    userAddress,
    inputMint,
    outputMint,
    amount,
    slippageBps = 50,
    providers = ['jupiter', 'raydium', 'orca'],
  }) {
    return this.requestWithX402('/v1/swap/quote', {
      input: { token: inputMint, amount: String(amount), chainKey: 'sol' },
      output: { token: outputMint, chainKey: 'sol' },
      chainKey: 'sol',
      userAddress,
      inputMint,
      outputMint,
      amount: String(amount),
      slippageBps,
      providers,
    });
  }

  /**
   * Paid Build-Tx Endpoint: POST /v1/swap/build-tx
   * Returns a ready-to-sign base64 Solana VersionedTransaction (non-custodial).
   */
  async buildSwapTransaction({ userAddress, quoteResponse, priorityFeeMicroLamports = 10000 }) {
    return this.requestWithX402('/v1/swap/build-tx', {
      chainKey: 'sol',
      userAddress,
      quoteResponse,
      priorityFeeMicroLamports,
    });
  }

  /**
   * Paid Conditional Limit / Bracket Order: POST /v1/orders/limit/create
   */
  async createLimitOrder({
    userAddress,
    inputMint,
    outputMint,
    makingAmount,
    takingAmount,
    stopLossPrice,
    takeProfitPrice,
    expirySeconds = 86400,
  }) {
    return this.requestWithX402('/v1/orders/limit/create', {
      chainKey: 'sol',
      userAddress,
      inputMint,
      outputMint,
      makingAmount: String(makingAmount),
      takingAmount: String(takingAmount),
      ...(stopLossPrice ? { stopLossPrice: String(stopLossPrice) } : {}),
      ...(takeProfitPrice ? { takeProfitPrice: String(takeProfitPrice) } : {}),
      expirySeconds,
    });
  }

  /**
   * Paid Automated DCA Order: POST /v1/orders/dca/create
   */
  async createDcaOrder({
    userAddress,
    inputMint,
    outputMint,
    totalAmount,
    sliceCount = 10,
    intervalSeconds = 3600,
  }) {
    return this.requestWithX402('/v1/orders/dca/create', {
      chainKey: 'sol',
      userAddress,
      inputMint,
      outputMint,
      totalAmount: String(totalAmount),
      sliceCount,
      intervalSeconds,
    });
  }
}
