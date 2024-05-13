import { ethers } from 'ethers';
import {
  DEFAULT_JSON_RPC_PROVIDER_OPTIONS,
  DeployNetworkKey,
  RANDOM_PRIVATE_KEY,
  config,
} from '~common-service';
import { SqrLaunchpadContext } from '~services';
import { SQRPaymentGateway__factory, SQRVesting__factory } from '~typechain-types';
import { getContractData } from '~utils';

export function getSqrLaunchpadContext(network: DeployNetworkKey): SqrLaunchpadContext {
  const rawProvider = new ethers.JsonRpcProvider(
    config.web3.provider[network].http,
    undefined,
    DEFAULT_JSON_RPC_PROVIDER_OPTIONS,
  );

  const { sqrLaunchpadData } = getContractData(network);
  const owner = new ethers.Wallet(config.web3.ownerPrivateKey ?? RANDOM_PRIVATE_KEY, rawProvider);
  const firstSqrPaymentGateway = SQRPaymentGateway__factory.connect(
    sqrLaunchpadData[0].address,
    owner,
  );
  const firstSqrVesting = SQRVesting__factory.connect(sqrLaunchpadData[0].address, owner);

  return {
    owner,
    rawProvider,
    firstSqrPaymentGateway,
    getSqrPaymentGateway: (address: string) => SQRPaymentGateway__factory.connect(address, owner),
    firstSqrVesting,
  };
}
