import { Promisable } from '~common';
import { NetworkObject } from '~common-service';
import { deployNetworks } from '~constants';
import { DeployNetworkKey } from '../types';
import { objectFactory } from './objects';

export function networkObjectFactory<T>(fn: (network: DeployNetworkKey) => T) {
  return objectFactory(deployNetworks, fn) as NetworkObject<T>;
}

export async function processNetworkObject<T>(
  object: Record<DeployNetworkKey, T>,
  fn: (network: DeployNetworkKey) => Promisable<any>,
  sync = true,
) {
  for (const key of Object.keys(object)) {
    sync ? await fn(key as DeployNetworkKey) : fn(key as DeployNetworkKey);
  }
}
