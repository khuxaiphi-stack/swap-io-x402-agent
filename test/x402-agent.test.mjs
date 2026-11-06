import test from 'node:test';
import assert from 'node:assert/strict';
import { HermesX402Client, SOLANA_TOKENS } from '../src/hermes-x402-agent-index.mjs';
import { AutonomousRebalancerAgent } from '../src/rebalancer-agent.mjs';

function createMockHermesServer() {
  const requests = [];
  const fetchImpl = async (url, options = {}) => {
    const hasPayment = Boolean(options.headers?.['X-PAYMENT']);
    const body = options.body ? JSON.parse(options.body) : null;
    requests.push({ url, method: options.method, hasPayment, body });

    if (url.endsWith('/v1/info')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({
          service: 'Swap.io Hermes Agent API',
          protocol: 'x402-solana',
          chains: ['sol'],
          providers: ['jupiter', 'raydium', 'orca', 'meteora'],
        }),
      };
    }

    if (url.includes('/v1/swap/status')) {
      return {
        ok: true,
        status: 200,
        json: async () => ({ chainKey: 'sol', status: 'CONFIRMED', slot: 319482104 }),
      };
    }

    // Paid endpoints return HTTP 402 when X-PAYMENT header is absent
    if (!hasPayment) {
      return {
        ok: false,
        status: 402,
        json: async () => ({
          x402Version: 1,
          error: 'Payment Required',
          accepts: [
            {
              scheme: 'exact',
              network: 'solana-mainnet',
              maxAmountRequired: '1000', // 0.001 USDC (6 decimals)
              resource: url,
              description: 'Swap.io Hermes API x402 micropayment',
              mimeType: 'application/json',
              payTo: 'BPz2u6eoWLervxEqfpsMCVmKk7h6fEVsd7L5rvEibMfD',
              asset: SOLANA_TOKENS.USDC.mint,
              extra: { feePayer: '2wKupLR9q6wXYppw8Gr2NvWxKBUqm4PPJKkQfoxHDBg4' },
            },
          ],
        }),
      };
    }

    // Paid retry succeeds and returns X-PAYMENT-RESPONSE settlement header
    const headers = new Map([
      [
        'x-payment-response',
        Buffer.from(
          JSON.stringify({
            success: true,
            txHash: '5x402SettlementSigSolscanProof111111111111111111111111',
            network: 'solana-mainnet',
          })
        ).toString('base64'),
      ],
    ]);

    if (url.endsWith('/v1/swap/quote')) {
      return {
        ok: true,
        status: 200,
        headers,
        json: async () => ({
          bestQuote: {
            provider: 'jupiter',
            inputMint: body.inputMint,
            outputMint: body.outputMint,
            inAmount: body.amount,
            outAmount: '142500000',
            priceImpactPct: '0.04',
          },
        }),
      };
    }

    if (url.endsWith('/v1/swap/build-tx')) {
      return {
        ok: true,
        status: 200,
        headers,
        json: async () => ({
          serializedTransaction: 'AQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABAAED',
          lastValidBlockHeight: 298410221,
        }),
      };
    }

    return { ok: true, status: 200, headers, json: async () => ({ orderId: 'ord_x402_991' }) };
  };

  return { fetchImpl, requests };
}

test('HermesX402Client handles HTTP 402 challenge, signs atomic USDC payment, and retries with X-PAYMENT', async () => {
  const { fetchImpl, requests } = createMockHermesServer();
  const client = new HermesX402Client({
    fetchImpl,
    paymentSigner: async (requirement) =>
      Buffer.from(
        JSON.stringify({
          x402Version: 1,
          scheme: requirement.scheme,
          network: requirement.network,
          amount: requirement.maxAmountRequired,
          payTo: requirement.payTo,
          signature: 'SIGNED_USDC_TRANSFER_AUTH',
        })
      ).toString('base64'),
  });

  const info = await client.getInfo();
  assert.equal(info.protocol, 'x402-solana');

  const quote = await client.getQuote({
    userAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    inputMint: SOLANA_TOKENS.SOL.mint,
    outputMint: SOLANA_TOKENS.USDC.mint,
    amount: 1_000_000_000,
    slippageBps: 30,
  });

  assert.equal(quote.status, 200);
  assert.equal(quote.paid, true);
  assert.equal(quote.ledgerEntry.usdcCost, 0.001);
  // 1 GET /v1/info + 1 unpaid POST (402) + 1 paid POST (200) = 3 HTTP calls
  assert.equal(requests.length, 3);
  assert.equal(requests[1].hasPayment, false);
  assert.equal(requests[2].hasPayment, true);
});

test('AutonomousRebalancerAgent spends $0.00 when portfolio drift is below threshold and executes x402 swap when threshold triggers', async () => {
  const { fetchImpl } = createMockHermesServer();
  const hermes = new HermesX402Client({
    fetchImpl,
    paymentSigner: async () => 'BASE64_X_PAYMENT_PAYLOAD',
  });

  const agent = new AutonomousRebalancerAgent({
    hermes,
    walletAddress: '7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU',
    driftThresholdPct: 3.5,
    targetSolWeight: 0.6,
    signAndBroadcastLocal: async () => '5xRebalanceSwapTxSignatureSolanaMainnet',
  });

  // 1. Flat market: 6 SOL @ $150 ($900) + $600 USDC = $1500 total -> 60.0% SOL weight (0% drift)
  const idleResult = await agent.runCycle({ solBalance: 6, usdcBalance: 600, solPriceUsd: 150 });
  assert.equal(idleResult.action, 'HOLD_IDLE_ZERO_COST');
  assert.equal(idleResult.usdcApiCost, 0);

  // 2. SOL rally: 6 SOL @ $200 ($1200) + $600 USDC = $1800 total -> 66.67% SOL weight (+6.67% drift > 3.5%)
  const activeResult = await agent.runCycle({ solBalance: 6, usdcBalance: 600, solPriceUsd: 200 });
  assert.equal(activeResult.action, 'REBALANCED_VIA_X402');
  assert.equal(activeResult.usdcApiCost, 0.002); // $0.001 quote + $0.001 build-tx
  assert.equal(activeResult.x402Receipts.length, 2);
  assert.equal(activeResult.status, 'CONFIRMED');
});
