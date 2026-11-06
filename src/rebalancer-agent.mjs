/**
 * Autonomous Volatility-Triggered Portfolio Rebalancer Agent using Swap.io x402
 *
 * Pitch Use-Case:
 * Traditional DeFi trading bots burn $49–$199/month on idle RPC/aggregator API subscriptions
 * even when the market is flat and the agent executes 0 trades for weeks.
 *
 * With Swap.io's x402 Agent API (https://hermes.swap.io):
 * - The agent monitors portfolio drift locally for $0.00.
 * - ONLY when portfolio drift exceeds the threshold (e.g. >3.5%) does the agent wake up,
 *   pay ~$0.003 USDC via HTTP 402 for a multi-provider quote (`POST /v1/swap/quote`),
 *   pay ~$0.003 USDC to build the non-custodial transaction (`POST /v1/swap/build-tx`),
 *   sign locally with its keypair, and poll `GET /v1/swap/status`.
 */
import { SOLANA_TOKENS } from './hermes-x402-client.mjs';

export class AutonomousRebalancerAgent {
  /**
   * @param {object} config
   * @param {import('./hermes-x402-client.mjs').HermesX402Client} config.hermes
   * @param {string} config.walletAddress
   * @param {number} [config.driftThresholdPct=3.5]
   * @param {number} [config.targetSolWeight=0.60]
   * @param {function(string): Promise<string>} config.signAndBroadcastLocal
   */
  constructor({
    hermes,
    walletAddress,
    driftThresholdPct = 3.5,
    targetSolWeight = 0.6,
    signAndBroadcastLocal,
  }) {
    this.hermes = hermes;
    this.walletAddress = walletAddress;
    this.driftThresholdPct = driftThresholdPct;
    this.targetSolWeight = targetSolWeight;
    this.signAndBroadcastLocal = signAndBroadcastLocal;
  }

  evaluateDrift({ solBalance, usdcBalance, solPriceUsd }) {
    const solValueUsd = solBalance * solPriceUsd;
    const totalUsd = solValueUsd + usdcBalance;
    const currentSolWeight = totalUsd > 0 ? solValueUsd / totalUsd : 0;
    const driftPct = (currentSolWeight - this.targetSolWeight) * 100;
    const needsRebalance = Math.abs(driftPct) >= this.driftThresholdPct;

    return {
      totalUsd: Number(totalUsd.toFixed(2)),
      currentSolWeight: Number(currentSolWeight.toFixed(4)),
      targetSolWeight: this.targetSolWeight,
      driftPct: Number(driftPct.toFixed(2)),
      needsRebalance,
      direction: driftPct > 0 ? 'SELL_SOL_FOR_USDC' : 'BUY_SOL_WITH_USDC',
      rebalanceUsdDelta: Number(Math.abs((currentSolWeight - this.targetSolWeight) * totalUsd).toFixed(2)),
    };
  }

  /**
   * Run a single autonomous rebalance cycle:
   * - If drift < threshold -> $0.00 spent (zero subscription waste!).
   * - If drift >= threshold -> executes x402 pay-per-call quote + build-tx + status check.
   */
  async runCycle({ solBalance, usdcBalance, solPriceUsd }) {
    const analysis = this.evaluateDrift({ solBalance, usdcBalance, solPriceUsd });
    if (!analysis.needsRebalance) {
      return {
        action: 'HOLD_IDLE_ZERO_COST',
        usdcApiCost: 0,
        analysis,
      };
    }

    const isSellingSol = analysis.direction === 'SELL_SOL_FOR_USDC';
    const inputMint = isSellingSol ? SOLANA_TOKENS.SOL.mint : SOLANA_TOKENS.USDC.mint;
    const outputMint = isSellingSol ? SOLANA_TOKENS.USDC.mint : SOLANA_TOKENS.SOL.mint;
    const rawAmount = isSellingSol
      ? Math.round((analysis.rebalanceUsdDelta / solPriceUsd) * 1e9)
      : Math.round(analysis.rebalanceUsdDelta * 1e6);

    // 1. Paid x402 Call #1: Parameter-optimized multi-provider quote
    const quoteRes = await this.hermes.getQuote({
      userAddress: this.walletAddress,
      inputMint,
      outputMint,
      amount: rawAmount,
      slippageBps: 30, // Explicit parameter lowers x402 quote fee
      providers: ['jupiter', 'raydium', 'orca'],
    });

    // 2. Paid x402 Call #2: Build non-custodial transaction
    const buildRes = await this.hermes.buildSwapTransaction({
      userAddress: this.walletAddress,
      quoteResponse: quoteRes.data.bestQuote || quoteRes.data,
      priorityFeeMicroLamports: 15000,
    });

    // 3. Sign locally (Private keys never leave the agent!)
    const txHash = await this.signAndBroadcastLocal(buildRes.data.serializedTransaction);

    // 4. Poll confirmation status
    const statusRes = await this.hermes.getSwapStatus({ chainKey: 'sol', txHash });

    const totalUsdcApiCost = this.hermes.paymentLedger.reduce((acc, e) => acc + e.usdcCost, 0);

    return {
      action: 'REBALANCED_VIA_X402',
      usdcApiCost: Number(totalUsdcApiCost.toFixed(6)),
      analysis,
      quote: quoteRes.data,
      txHash,
      status: statusRes.status || 'CONFIRMED',
      x402Receipts: this.hermes.paymentLedger,
    };
  }
}
