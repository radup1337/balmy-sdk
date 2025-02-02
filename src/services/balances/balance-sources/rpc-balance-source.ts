import { Address as ViemAddress } from 'viem';
import { Address, ChainId, TimeString, TokenAddress } from '@types';
import { BalanceQueriesSupport } from '../types';
import { IProviderService } from '@services/providers/types';
import { SingleChainBaseBalanceSource } from './base/single-chain-base-balance-source';
import ERC20_ABI from '@shared/abis/erc20';
import { MULTICALL_ADDRESS } from '@services/providers/utils';

export type RPCBalanceSourceConfig = {
  batching?: { maxSizeInBytes: number };
};
export class RPCBalanceSource extends SingleChainBaseBalanceSource {
  constructor(private readonly providerService: IProviderService, private readonly config?: RPCBalanceSourceConfig | undefined) {
    super();
  }

  supportedQueries(): Record<ChainId, BalanceQueriesSupport> {
    const supportedChains = this.providerService.supportedChains();
    const entries = supportedChains.map((chainId) => [chainId, { getBalancesForTokens: true, getTokensHeldByAccount: false }]);
    return Object.fromEntries(entries);
  }

  protected fetchERC20TokensHeldByAccountsInChain(
    chainId: ChainId,
    accounts: Address[],
    config?: { timeout?: TimeString }
  ): Promise<Record<Address, Record<TokenAddress, bigint>>> {
    throw new Error('Operation not supported');
  }

  protected async fetchERC20BalancesForAccountsInChain(
    chainId: ChainId,
    accounts: Record<Address, TokenAddress[]>,
    config?: { timeout?: TimeString }
  ): Promise<Record<Address, Record<TokenAddress, bigint>>> {
    const pairs = Object.entries(accounts).flatMap(([account, tokens]) => tokens.map((token) => ({ account, token })));
    const contracts = pairs.map(({ account, token }) => ({
      address: token as ViemAddress,
      abi: ERC20_ABI,
      functionName: 'balanceOf',
      args: [account],
    }));
    const multicallResults = contracts.length
      ? await this.providerService.getViemPublicClient({ chainId }).multicall({
          contracts,
          multicallAddress: MULTICALL_ADDRESS,
          batchSize: 0,
          ...this.config,
        })
      : [];
    const result: Record<Address, Record<TokenAddress, bigint>> = {};
    for (let i = 0; i < pairs.length; i++) {
      const multicallResult = multicallResults[i];
      if (multicallResult.status === 'failure') continue;
      const { account, token } = pairs[i];
      if (!(account in result)) result[account] = {};
      result[account][token] = multicallResult.result as unknown as bigint;
    }
    return result;
  }

  protected async fetchNativeBalancesInChain(
    chainId: ChainId,
    accounts: Address[],
    config?: { timeout?: TimeString }
  ): Promise<Record<Address, bigint>> {
    const entries = await Promise.all(accounts.map(async (account) => [account, await this.fetchNativeBalanceInChain(chainId, account)]));
    return Object.fromEntries(entries);
  }

  private fetchNativeBalanceInChain(chainId: ChainId, account: Address) {
    return this.providerService.getViemPublicClient({ chainId }).getBalance({ address: account as ViemAddress, blockTag: 'latest' });
  }
}
