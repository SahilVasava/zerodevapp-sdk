import '@ethersproject/shims'
import { Buffer } from 'buffer'

import { ethers, Signer } from 'ethers'

import { getProvider, getRpcUrl } from './utils'
import * as api from './api'
import * as constants from './constants'
import { Hooks } from './ClientConfig'
import { ZeroDevSigner } from './ZeroDevSigner'
import { ZeroDevProvider } from './ZeroDevProvider'
import { wrapProvider, wrapV2Provider } from './Provider'
import { AccountImplementation, kernelAccount_v2_audited, kernelAccount_v1_audited } from './accounts'
import { BaseAccountAPI, BaseApiParams } from './BaseAccountAPI'
import { SupportedGasToken } from './types'
import { getPaymaster } from './paymasters'
import { InfuraProvider, InfuraWebSocketProvider, JsonRpcProvider, FallbackProvider } from '@ethersproject/providers'
import { BaseValidatorAPI } from './validators'
global.Buffer = Buffer

export { ZeroDevSigner, AssetTransfer, AssetType } from './ZeroDevSigner'
export { ZeroDevProvider } from './ZeroDevProvider'
export { UserOperationReceipt } from './HttpRpcClient'
export { getPrivateKeyOwner, getRPCProviderOwner } from './owner'
export { createSessionKey, createSessionKeySigner, revokeSessionKey } from './session'

export interface AccountParams {
  projectId: string
  owner: Signer
  index?: number
  rpcProvider?: JsonRpcProvider | FallbackProvider
  bundlerUrl?: string
  hooks?: Hooks
  address?: string
  implementation?: AccountImplementation<BaseAccountAPI, BaseApiParams>
  skipFetchSetup?: boolean
  gasToken?: SupportedGasToken
  useWebsocketProvider?: boolean
  transactionTimeout?: number
}

export async function getZeroDevProvider (params: AccountParams): Promise<ZeroDevProvider> {
  const chainId = await api.getChainId(params.projectId, constants.BACKEND_URL)
  const provider = params.rpcProvider ?? (await getProvider(chainId, getRpcUrl(chainId), params.useWebsocketProvider, params.skipFetchSetup))

  const aaConfig = {
    projectId: params.projectId,
    chainId,
    entryPointAddress: constants.ENTRYPOINT_ADDRESS,
    bundlerUrl: params.bundlerUrl ?? constants.BUNDLER_URL,
    paymasterAPI: await getPaymaster(
      params.projectId,
      constants.PAYMASTER_URL,
      chainId,
      constants.ENTRYPOINT_ADDRESS,
      params.gasToken
    ),
    hooks: params.hooks,
    walletAddress: params.address,
    index: params.index,
    implementation: params.implementation ?? kernelAccount_v1_audited
  }

  const aaProvider = await wrapProvider(provider, aaConfig, params.owner, { skipFetchSetup: params.skipFetchSetup, transactionTimeout: params.transactionTimeout })
  return aaProvider
}

export async function getZeroDevProviderV2 (params: AccountParams,
  validator: BaseValidatorAPI,
  defaultValidator?: BaseValidatorAPI
): Promise<ZeroDevProvider> {
  const chainId = await api.getChainId(params.projectId, constants.BACKEND_URL)
  const provider = params.rpcProvider ?? (await getProvider(chainId, getRpcUrl(chainId), params.useWebsocketProvider, params.skipFetchSetup))

  const aaConfig = {
    projectId: params.projectId,
    chainId,
    entryPointAddress: constants.ENTRYPOINT_ADDRESS,
    bundlerUrl: params.bundlerUrl ?? constants.BUNDLER_URL,
    paymasterAPI: await getPaymaster(
      params.projectId,
      constants.PAYMASTER_URL,
      chainId,
      constants.ENTRYPOINT_ADDRESS,
      params.gasToken
    ),
    hooks: params.hooks,
    walletAddress: params.address,
    index: params.index,
    implementation: params.implementation ?? kernelAccount_v2_audited
  }
  const aaProvider = await wrapV2Provider(
    provider, aaConfig, params.owner, (defaultValidator != null) ? defaultValidator : validator, validator, { skipFetchSetup: params.skipFetchSetup, bundlerGasCalculation: true, transactionTimeout: params.transactionTimeout }
  )
  return aaProvider
}

export async function getZeroDevSigner (
  params: AccountParams
): Promise<ZeroDevSigner> {
  const aaProvider = await getZeroDevProvider(params)
  const aaSigner = aaProvider.getSigner()

  return aaSigner
}

export async function getZeroDevSignerV2 (
  params: AccountParams,
  validator: BaseValidatorAPI,
  defaultValidator?: BaseValidatorAPI
): Promise<ZeroDevSigner> {
  const aaProvider = await getZeroDevProviderV2(params, validator, defaultValidator)
  const aaSigner = aaProvider.getSigner()

  return aaSigner
}

// Check if a signer is a ZeroDevSigner
export async function isZeroDevSigner (signer: any) {
  return signer instanceof ZeroDevSigner
}

// Typecast a signer to a ZeroDevSigner, or throw if it's not a ZeroDevSigner
export function asZeroDevSigner (signer: Signer): ZeroDevSigner {
  if (!(signer instanceof ZeroDevSigner)) {
    throw new Error('not a ZeroDevSigner')
  }
  return signer
}

export async function initiateProject (projectIds: string[]): Promise<void> {
  void api.getProjectsConfiguration(projectIds, constants.BACKEND_URL)
}

export const getProjectsConfiguration = api.getProjectsConfiguration
