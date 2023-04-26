import { TransactionReceipt } from '@ethersproject/providers'
import * as constants from './constants'
import { ProjectConfiguration } from './types'

export const signUserOp = async (
  projectId: string,
  chainId: number,
  userOp: any,
  entryPointAddress: string,
  paymasterUrl?: string,
): Promise<any> => {
  try {
    const resp = await fetch(`${paymasterUrl ?? constants.PAYMASTER_URL}/sign`, {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        chainId,
        userOp: userOp,
        entryPointAddress,
      }),
      headers: { 'Content-Type': 'application/json' },
    })
    const paymasterResp = await resp.json()
    return paymasterResp
  } catch (e) {
    console.log(e)
    return undefined
  }
}

export const getChainId = async (
  projectId: string,
  backendUrl?: string
): Promise<number> => {
  const resp = await fetch(
    `${backendUrl ?? constants.BACKEND_URL}/v1/projects/get-chain-id`,
    {
      method: 'POST',
      body: JSON.stringify({
        projectId: projectId,
      }),
      headers: { 'Content-Type': 'application/json' },
    }
  )
  const { chainId } = await resp.json()
  return chainId
}

const projectConfigurationCache: { [key: string]: ProjectConfiguration } = {}

export const getProjectConfiguration = async (
  projectId: string,
  backendUrl?: string
): Promise<ProjectConfiguration> => {
  // If the result is already cached, return it
  if (projectConfigurationCache[projectId] !== undefined) {
    return projectConfigurationCache[projectId]
  }

  // Fetch the data and cache it
  const resp = await fetch(
    `${backendUrl ?? constants.BACKEND_URL}/v1/projects/${projectId}`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }
  )
  const projectConfiguration = await resp.json()

  // Cache the fetched result
  projectConfigurationCache[projectId] = projectConfiguration

  return projectConfiguration
}

export const getProjectsConfiguration = async (
  projectIds: string[],
  backendUrl?: string
): Promise<ProjectConfiguration> => {
  // If the result is already cached, return it
  const projectIdsKey = projectIds.join('-')
  if (projectConfigurationCache[projectIdsKey] !== undefined) {
    return projectConfigurationCache[projectIdsKey]
  }

  // Fetch the data and cache it
  const resp = await fetch(
    `${backendUrl ?? constants.BACKEND_URL}/v1/projects/get`,
    {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        projectIds: projectIds.map(projectId => projectId.toString())
      })
    }
  )
  const projectConfiguration = await resp.json()

  // Cache the fetched result
  projectConfigurationCache[projectIdsKey] = projectConfiguration

  return projectConfiguration
}

export const getPrivateKeyByToken = async (
  projectId: string,
  identity: string,
  token: string,
  backendUrl?: string
): Promise<string> => {
  const resp = await fetch(
    `${backendUrl ?? constants.BACKEND_URL}/v1/keys/get-by-token`,
    {
      method: 'POST',
      body: JSON.stringify({
        projectId,
        identity,
        token,
      }),
      headers: { 'Content-Type': 'application/json' },
    }
  )
  const { privateKey } = await resp.json()
  return privateKey
}
