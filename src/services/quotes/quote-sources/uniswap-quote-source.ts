import { Chains } from '@chains';
import { ChainId, Chain, TokenAddress } from '@types';
import { Addresses } from '@shared/constants';
import { isSameAddress, subtractPercentage, timeToSeconds } from '@shared/utils';
import { QuoteParams, QuoteSourceMetadata, SourceQuoteResponse } from './types';
import { addQuoteSlippage, calculateAllowanceTarget, failed } from './utils';
import { AlwaysValidConfigAndContextSource } from './base/always-valid-source';
import { encodeFunctionData, parseAbi } from 'viem';

const ROUTER_ADDRESS: Record<ChainId, string> = {
  [Chains.ETHEREUM.chainId]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [Chains.OPTIMISM.chainId]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [Chains.POLYGON.chainId]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [Chains.ARBITRUM.chainId]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [Chains.CELO.chainId]: '0x5615CDAb10dc425a742d643d949a7F474C01abc4',
  [Chains.ETHEREUM_GOERLI.chainId]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [Chains.POLYGON_MUMBAI.chainId]: '0x68b3465833fb72A70ecDF485E0e4C7bD8665Fc45',
  [Chains.BNB_CHAIN.chainId]: '0xB971eF87ede563556b2ED4b1C0b0019111Dd85d2',
  [Chains.BASE.chainId]: '0x2626664c2603336E57B271c5C0b26F421741e481',
  [Chains.AVALANCHE.chainId]: '0xbb00FF08d01D300023C629E8fFfFcb65A5a578cE',
};

const UNISWAP_METADATA: QuoteSourceMetadata<UniswapSupport> = {
  name: 'Uniswap',
  supports: {
    chains: Object.keys(ROUTER_ADDRESS).map(Number),
    swapAndTransfer: true,
    buyOrders: true,
  },
  logoURI: 'ipfs://QmNa3YBYAYS5qSCLuXataV5XCbtxP9ZB4rHUfomRxrpRhJ',
};
type UniswapSupport = { buyOrders: true; swapAndTransfer: true };
export class UniswapQuoteSource extends AlwaysValidConfigAndContextSource<UniswapSupport> {
  getMetadata() {
    return UNISWAP_METADATA;
  }

  async quote({
    components: { fetchService },
    request: {
      chain,
      sellToken,
      buyToken,
      order,
      config: { slippagePercentage, timeout, txValidFor },
      accounts: { takeFrom, recipient },
    },
  }: QuoteParams<UniswapSupport>): Promise<SourceQuoteResponse> {
    const amount = order.type === 'sell' ? order.sellAmount : order.buyAmount;
    const isSellTokenNativeToken = isSameAddress(sellToken, Addresses.NATIVE_TOKEN);
    const isBuyTokenNativeToken = isSameAddress(buyToken, Addresses.NATIVE_TOKEN);
    if (isSellTokenNativeToken && order.type === 'buy') {
      // We do this because it's very hard and expensive to wrap native to wToken, spend only
      // some of it and then return the extra native token to the caller
      throw new Error(`Uniswap does not support buy orders with native token`);
    }
    const router = ROUTER_ADDRESS[chain.chainId];
    recipient = recipient ?? takeFrom;
    const url =
      'https://api.uniswap.org/v1/quote' +
      '?protocols=v2,v3,mixed' +
      `&tokenInAddress=${mapToWTokenIfNecessary(chain, sellToken)}` +
      `&tokenInChainId=${chain.chainId}` +
      `&tokenOutAddress=${mapToWTokenIfNecessary(chain, buyToken)}` +
      `&tokenOutChainId=${chain.chainId}` +
      `&amount=${amount.toString()}` +
      `&type=${order.type === 'sell' ? 'exactIn' : 'exactOut'}` +
      `&recipient=${isBuyTokenNativeToken ? router : recipient}` +
      `&deadline=${timeToSeconds(txValidFor ?? '3h')}` +
      `&slippageTolerance=${slippagePercentage}`;

    // These are needed so that the API allows us to make the call
    const headers = {
      origin: 'https://app.uniswap.org',
      referer: 'https://app.uniswap.org/',
    };
    const response = await fetchService.fetch(url, { headers, timeout });
    if (!response.ok) {
      failed(UNISWAP_METADATA, chain, sellToken, buyToken, await response.text());
    }
    let {
      quote: quoteAmount,
      methodParameters: { calldata },
      gasUseEstimate,
    } = await response.json();
    const sellAmount = order.type === 'sell' ? order.sellAmount : BigInt(quoteAmount);
    const buyAmount = order.type === 'sell' ? BigInt(quoteAmount) : order.buyAmount;
    const value = isSellTokenNativeToken ? sellAmount : undefined;

    if (isBuyTokenNativeToken) {
      // Use multicall to unwrap wToken
      const minBuyAmount = calculateMinBuyAmount(order.type, buyAmount, slippagePercentage);
      const unwrapData = encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'unwrapWETH9',
        args: [minBuyAmount, recipient],
      });
      const multicallData = encodeFunctionData({
        abi: ROUTER_ABI,
        functionName: 'multicall',
        args: [[calldata, unwrapData]],
      });

      // Update calldata and gas estimate
      calldata = multicallData!;
      gasUseEstimate = BigInt(gasUseEstimate) + 12_500n;
    }

    const quote = {
      sellAmount,
      buyAmount,
      estimatedGas: BigInt(gasUseEstimate),
      allowanceTarget: calculateAllowanceTarget(sellToken, router),
      tx: {
        to: router,
        calldata,
        value,
      },
    };
    return addQuoteSlippage(quote, order.type, slippagePercentage);
  }
}

function calculateMinBuyAmount(type: 'sell' | 'buy', buyAmount: bigint, slippagePercentage: number) {
  return type === 'sell' ? BigInt(subtractPercentage(buyAmount, slippagePercentage, 'up')) : buyAmount;
}

function mapToWTokenIfNecessary(chain: Chain, address: TokenAddress) {
  return isSameAddress(address, Addresses.NATIVE_TOKEN) ? chain.wToken : address;
}

const ROUTER_HUMAN_READABLE_ABI = [
  'function unwrapWETH9(uint256 amountMinimum, address recipient) payable',
  'function multicall(bytes[] data) payable returns (bytes[] memory results)',
];

const ROUTER_ABI = parseAbi(ROUTER_HUMAN_READABLE_ABI);
