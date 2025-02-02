import { Chains } from '@chains';
import { QuoteParams, QuoteSourceMetadata, SourceQuoteResponse } from './types';
import { calculateAllowanceTarget, failed } from './utils';
import { formatUnits, parseUnits } from 'viem';
import { AlwaysValidConfigAndContextSource } from './base/always-valid-source';
import { ChainId } from '@types';

const SUPPORTED_CHAINS: Record<ChainId, string> = {
  [Chains.ARBITRUM.chainId]: 'ARBITRUM',
  [Chains.AVALANCHE.chainId]: 'AVALANCHE',
  [Chains.BASE.chainId]: 'BASE',
  [Chains.FANTOM.chainId]: 'FANTOM',
  [Chains.GNOSIS.chainId]: 'GNOSIS',
  [Chains.ETHEREUM.chainId]: 'MAINNET',
  [Chains.POLYGON.chainId]: 'POLYGON',
  [Chains.OPTIMISM.chainId]: 'OPTIMISM',
  [Chains.POLYGON_ZKEVM.chainId]: 'ZKEVM',
  [Chains.ETHEREUM_SEPOLIA.chainId]: 'SEPOLIA',
};

const BALANCER_METADATA: QuoteSourceMetadata<BalancerSupport> = {
  name: 'Balancer',
  supports: {
    chains: Object.keys(SUPPORTED_CHAINS).map(Number),
    swapAndTransfer: false,
    buyOrders: true,
  },
  logoURI: 'ipfs://QmSb9Lr6Jgi9Y3RUuShfWcuCaa9EYxpyZWgBTe8GbvsUL7',
};
type BalancerSupport = { buyOrders: true; swapAndTransfer: false };
export class BalancerQuoteSource extends AlwaysValidConfigAndContextSource<BalancerSupport> {
  getMetadata() {
    return BALANCER_METADATA;
  }
  async quote({
    components: { fetchService },
    request: {
      chain,
      sellToken,
      buyToken,
      order,
      accounts: { takeFrom },
      config: { slippagePercentage },
      external,
    },
    config,
  }: QuoteParams<BalancerSupport>): Promise<SourceQuoteResponse> {
    const { sellToken: sellTokenDataResult, buyToken: buyTokenDataResult } = await external.tokenData.request();
    const amount =
      order.type == 'sell'
        ? formatUnits(order.sellAmount, sellTokenDataResult.decimals)
        : formatUnits(order.buyAmount, buyTokenDataResult.decimals);
    const query = {
      query: `query {
        sorGetSwapPaths( 
          chain: ${SUPPORTED_CHAINS[chain.chainId]}
          swapAmount: "${amount}"
          swapType: ${order.type == 'sell' ? 'EXACT_IN' : 'EXACT_OUT'}
          tokenIn: "${sellToken}"
          tokenOut: "${buyToken}"
          queryBatchSwap: true
          callDataInput: {sender: "${takeFrom}", receiver: "${takeFrom}", slippagePercentage: "${slippagePercentage}"}
        ) {
          tokenInAmount
          tokenOutAmount
          callData {
            value
            to
            maxAmountInRaw
            minAmountOutRaw
            callData
          }
        }
      }`,
    };
    const quoteResponse = await fetchService.fetch(`https://api-v3.balancer.fi/`, {
      method: 'POST',
      headers: { ['Content-Type']: 'application/json' },
      body: JSON.stringify(query),
    });

    if (!quoteResponse.ok) {
      failed(BALANCER_METADATA, chain, sellToken, buyToken, await quoteResponse.text());
    }
    const quoteResult = await quoteResponse.json();

    if (!quoteResult.data.sorGetSwapPaths.callData) {
      failed(BALANCER_METADATA, chain, sellToken, buyToken, await quoteResponse.text());
    }

    const {
      callData: { callData: data, to, value, minAmountOutRaw, maxAmountInRaw },
      tokenInAmount,
      tokenOutAmount,
    } = quoteResult.data.sorGetSwapPaths;
    const allowanceAddress = calculateAllowanceTarget(sellToken, to);
    const minBuyAmount = order.type === 'sell' ? parseUnits(minAmountOutRaw, buyTokenDataResult.decimals) : BigInt(tokenOutAmount);
    const maxSellAmount = order.type === 'sell' ? BigInt(tokenInAmount) : parseUnits(maxAmountInRaw, sellTokenDataResult.decimals);
    return {
      sellAmount: BigInt(tokenInAmount),
      buyAmount: BigInt(tokenOutAmount),
      estimatedGas: undefined,
      minBuyAmount,
      maxSellAmount,
      allowanceTarget: allowanceAddress,
      type: order.type,
      tx: {
        calldata: data,
        to,
        value: BigInt(value ?? 0),
      },
    };
  }
}
