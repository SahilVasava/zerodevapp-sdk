import { ethers, BigNumber, BigNumberish, Signer } from 'ethers'
import { Provider } from '@ethersproject/providers'
import {
  UserOperationStruct
} from '@zerodevapp/contracts'
import {
  EntryPoint, EntryPoint__factory
} from '@zerodevapp/contracts-new'

import { TransactionDetailsForUserOp } from './TransactionDetailsForUserOp'
import { Bytes, BytesLike, Result, resolveProperties } from 'ethers/lib/utils'
import { PaymasterAPI } from './paymasters/PaymasterAPI'
import { NotPromise, packUserOp } from '@account-abstraction/utils'
import { calcPreVerificationGas, GasOverheads } from './calcPreVerificationGas'
import { HttpRpcClient } from './HttpRpcClient'
import { fixSignedData, parseNumber } from './utils'
import { getMultiSendAddress, MultiSendCall } from './multisend'
import { TokenPaymasterAPI } from './paymasters/TokenPaymasterAPI'

export interface BaseApiParams {
  owner: Signer
  index?: number
  provider: Provider
  entryPointAddress: string
  accountAddress?: string
  overheads?: Partial<GasOverheads>
  paymasterAPI?: PaymasterAPI
  httpRpcClient?: HttpRpcClient
}

export type AccountAPIArgs<T = {}> = BaseApiParams & T

export type AccountAPIConstructor<T extends BaseAccountAPI, A = {}> = new (args: AccountAPIArgs<BaseApiParams & A>) => T

export enum ExecuteType {
  EXECUTE = 'execute',
  EXECUTE_DELEGATE = 'executeDelegate',
  EXECUTE_BATCH = 'executeBatch',
}

export interface UserOpResult {
  transactionHash: string
  success: boolean
}

interface FeeData {
  maxFeePerGas: BigNumber | null
  maxPriorityFeePerGas: BigNumber | null
}

/**
 * Base class for all Smart Wallet ERC-4337 Clients to implement.
 * Subclass should inherit 5 methods to support a specific wallet contract:
 *
 * - getAccountInitCode - return the value to put into the "initCode" field, if the account is not yet deployed. should create the account instance using a factory contract.
 * - getNonce - return current account's nonce value
 * - encodeExecute - encode the call from entryPoint through our account to the target contract.
 * - signUserOpHash - sign the hash of a UserOp.
 *
 * The user can use the following APIs:
 * - createUnsignedUserOp - given "target" and "calldata", fill userOp to perform that operation from the account.
 * - createSignedUserOp - helper to call the above createUnsignedUserOp, and then extract the userOpHash and sign it
 */
export abstract class BaseAccountAPI {
  private isPhantom = true
  // entryPoint connected to "zero" address. allowed to make static calls (e.g. to getSenderAddress)
  private readonly entryPointView: EntryPoint

  owner: Signer
  index: number
  provider: Provider
  overheads?: Partial<GasOverheads>
  entryPointAddress: string
  accountAddress?: string
  paymasterAPI?: PaymasterAPI
  httpRpcClient?: HttpRpcClient

  /**
   * base constructor.
   * subclass SHOULD add parameters that define the owner (signer) of this wallet
   */
  protected constructor (params: BaseApiParams) {
    this.owner = params.owner
    this.index = params.index ?? 0
    this.provider = params.provider
    this.overheads = params.overheads
    this.entryPointAddress = params.entryPointAddress
    this.accountAddress = params.accountAddress
    this.paymasterAPI = params.paymasterAPI
    this.httpRpcClient = params.httpRpcClient

    // factory "connect" define the contract address. the contract "connect" defines the "from" address.
    this.entryPointView = EntryPoint__factory.connect(params.entryPointAddress, params.provider).connect(ethers.constants.AddressZero)
  }

  /**
   * Creates an instance of a class extending BaseAccountAPI.
   * This static factory method is used to bypass the protected constructor constraint
   * and allows the creation of instances without directly calling the constructor.
   *
   * @param AccountAPIConstructor - The constructor of the class extending BaseAccountAPI.
   * @param args - The constructor arguments to be passed to the AccountAPIConstructor.
   * @returns An instance of the provided class.
   */
  public static create<T extends BaseAccountAPI, A>(AccountAPIConstructor: new (args: AccountAPIArgs<A>) => T, args: AccountAPIArgs<A>): T {
    return new AccountAPIConstructor(args)
  }

  async init (): Promise<this> {
    if (await this.provider.getCode(this.entryPointAddress) === '0x') {
      throw new Error(`entryPoint not deployed at ${this.entryPointAddress}`)
    }

    await this.getAccountAddress()
    return this
  }

  /**
   * return the value to put into the "initCode" field, if the contract is not yet deployed.
   * this value holds the "factory" address, followed by this account's information
   */
  abstract getAccountInitCode (): Promise<string>

  /**
   * return current account's nonce.
   */
  abstract getNonce (): Promise<BigNumber>

  /**
   * encode the call from entryPoint through our account to the target contract.
   * @param target
   * @param value
   * @param data
   */
  abstract encodeExecute (target: string, value: BigNumberish, data: string): Promise<string>

  /**
   * encode the delegatecall from entryPoint through our account to the target contract.
   * @param target
   * @param value
   * @param data
   */
  abstract encodeExecuteDelegate (target: string, value: BigNumberish, data: string): Promise<string>

  /**
   * decode the delegatecall from entryPoint through our account to the target contract.
   * @param data
   */
  abstract decodeExecuteDelegate (data: BytesLike): Promise<Result>

  /**
   * Encodes a batch of method calls for execution.
   *
   * @template A - The call's arguments type.
   * @template T - The options type for execution.
   * @param {Array<Call>} calls - An array of method calls to be encoded and executed.
   * @returns {Promise<string>} - A Promise that resolves to the encoded batch of method calls.
   * @throws {Error} - Throws an error if the method is not implemented in the child class.
   */
  abstract encodeExecuteBatch (calls: MultiSendCall[]): Promise<string>

  /**
   * sign a userOp's hash (userOpHash).
   * @param userOpHash
   */
  abstract signUserOpHash (userOpHash: string): Promise<string>

  abstract signMessage (message: Bytes | string): Promise<string>

  // for ERC-6492
  abstract getFactoryAddress (): Promise<string>

  // for ERC-6492
  abstract getFactoryAccountInitCode (): Promise<string>

  /**
   * check if the contract is already deployed.
   */
  async checkAccountPhantom (): Promise<boolean> {
    if (!this.isPhantom) {
      // already deployed. no need to check anymore.
      return this.isPhantom
    }
    const senderAddressCode = await this.provider.getCode(this.getAccountAddress())
    if (senderAddressCode.length > 2) {
      // console.log(`SimpleAccount Contract already deployed at ${this.senderAddress}`)
      this.isPhantom = false
    } else {
      // console.log(`SimpleAccount Contract is NOT YET deployed at ${this.senderAddress} - working in "phantom account" mode.`)
    }
    return this.isPhantom
  }

  /**
   * calculate the account address even before it is deployed
   */
  async getCounterFactualAddress (): Promise<string> {
    const initCode = await this.getAccountInitCode()
    // use entryPoint to query account address (factory can provide a helper method to do the same, but
    // this method attempts to be generic
    try {
      await this.entryPointView.callStatic.getSenderAddress(initCode)
    } catch (e: any) {
      if (e.errorArgs) {
        return e.errorArgs.sender
      } else {
        throw e
      }
    }
    throw new Error('must handle revert')
  }

  /**
   * return initCode value to into the UserOp.
   * (either deployment code, or empty hex if contract already deployed)
   */
  async getInitCode (): Promise<string> {
    if (await this.checkAccountPhantom()) {
      return await this.getAccountInitCode()
    }
    return '0x'
  }

  /**
   * return maximum gas used for verification.
   * NOTE: createUnsignedUserOp will add to this value the cost of creation, if the contract is not yet created.
   */
  async getVerificationGasLimit (): Promise<BigNumberish> { // TODO: need to check on-chain for this one
    return 110000
  }

  /**
   * should cover cost of putting calldata on-chain, and some overhead.
   * actual overhead depends on the expected bundle size
   */
  async getPreVerificationGas (userOp: Partial<UserOperationStruct>): Promise<number> {
    const p = await resolveProperties(userOp)
    return calcPreVerificationGas(p, this.overheads)
  }

  /**
   * ABI-encode a user operation. used for calldata cost estimation
   */
  packUserOp (userOp: NotPromise<UserOperationStruct>): string {
    return packUserOp(userOp, false)
  }

  /**
   * Encodes the user operation call data and calculates the gas limit for the transaction.
   *
   * @param detailsForUserOp - The transaction details for the user operation.
   * @returns A promise that resolves to an object containing the encoded call data and the calculated gas limit as a BigNumber.
   */
  async encodeUserOpCallDataAndGasLimit (detailsForUserOp: TransactionDetailsForUserOp, executeType: ExecuteType = ExecuteType.EXECUTE): Promise<{ callData: string, callGasLimit: BigNumber }> {
    const value = parseNumber(detailsForUserOp.value) ?? BigNumber.from(0)
    let callData

    switch (executeType) {
      case ExecuteType.EXECUTE_DELEGATE:
        callData = await this.encodeExecuteDelegate(detailsForUserOp.target, value, detailsForUserOp.data)
        break
      case ExecuteType.EXECUTE_BATCH:
        callData = detailsForUserOp.data
        break
      case ExecuteType.EXECUTE:
      default:
        callData = await this.encodeExecute(detailsForUserOp.target, value, detailsForUserOp.data)
        break
    }

    const callGasLimit = parseNumber(detailsForUserOp.gasLimit) ?? await this.provider.estimateGas({
      from: this.entryPointAddress,
      to: this.getAccountAddress(),
      data: callData
    })

    return {
      callData,
      callGasLimit
    }
  }

  /**
   * return userOpHash for signing.
   * This value matches entryPoint.getUserOpHash (calculated off-chain, to avoid a view call)
   * @param userOp userOperation, (signature field ignored)
   */
  async getUserOpHash (userOp: UserOperationStruct): Promise<string> {
    // const chainId = await this.provider.getNetwork().then(net => net.chainId)
    // return getUserOpHash(op, this.entryPointAddress, chainId)
    return await this.entryPointView.getUserOpHash({
      ...userOp,
      signature: '0x'
    })
  }

  /**
   * return the account's address.
   * this value is valid even before deploying the contract.
   */
  async getAccountAddress (): Promise<string> {
    if (this.accountAddress == null) { // means it needs deployment
      this.accountAddress = await this.getCounterFactualAddress()
    }
    return this.accountAddress
  }

  async estimateCreationGas (initCode?: string): Promise<BigNumberish> {
    if (initCode == null || initCode === '0x') return 0
    const deployerAddress = initCode.substring(0, 42)
    const deployerCallData = '0x' + initCode.substring(42)
    return await this.provider.estimateGas({ to: deployerAddress, data: deployerCallData })
  }

  /**
   * create a UserOperation, filling all details (except signature)
   * - if account is not yet created, add initCode to deploy it.
   * - if gas or nonce are missing, read them from the chain (note that we can't fill gaslimit before the account is created)
   * @param info
   */
  async createUnsignedUserOp (info: TransactionDetailsForUserOp, executeType: ExecuteType = ExecuteType.EXECUTE): Promise<UserOperationStruct> {
    const { callData, callGasLimit } = await this.encodeUserOpCallDataAndGasLimit(info, executeType)
    const initCode = await this.getInitCode()

    const verificationGasLimit = this.getVerificationGasLimit()

    const {
      maxFeePerGas,
      maxPriorityFeePerGas
    } = info
    let feeData
    // at least one of these needs to be set
    if (!maxFeePerGas && !maxPriorityFeePerGas) {
      feeData = this.getFeeData()
      // maxFeePerGas = feeData.maxFeePerGas ?? undefined
      // maxPriorityFeePerGas = feeData.maxPriorityFeePerGas ?? undefined
    }
    const initGas = this.estimateCreationGas(initCode)

    const partialUserOp: any = {
      sender: this.getAccountAddress(),
      nonce: info.nonce ?? this.getNonce(),
      initCode,
      callData,
      callGasLimit: initCode.length > 2 ? BigNumber.from('1000000') : callGasLimit,
      verificationGasLimit: BigNumber.from(await verificationGasLimit).add(await initGas),
      maxFeePerGas: (feeData != null) ? ((await feeData).maxFeePerGas ?? undefined) : maxFeePerGas,
      maxPriorityFeePerGas: (feeData != null) ? ((await feeData).maxPriorityFeePerGas ?? undefined) : maxPriorityFeePerGas,
      // Dummy values are required here
      paymasterAndData:
        '0xfe7dbcab8aaee4eb67943c1e6be95b1d065985c6000000000000000000000000000000000000000000000000000001869aa31cf400000000000000000000000000000000000000000000000000000000000000007dfe2190f34af27b265bae608717cdc9368b471fc0c097ab7b4088f255b4961e57b039e7e571b15221081c5dce7bcb93459b27a3ab65d2f8a889f4a40b4022801b',
      signature: info.dummySig ?? '0x4046ab7d9c387d7a5ef5ca0777eded29767fd9863048946d35b3042d2f7458ff7c62ade2903503e15973a63a296313eab15b964a18d79f4b06c8c01c7028143c1c'
    }
    partialUserOp.preVerificationGas = this.getPreVerificationGas(partialUserOp)

    // this is needed for the 0.6 StackUp bundlers
    partialUserOp.paymasterAndData = '0x'

    let paymasterResp: any
    if (this.paymasterAPI != null) {
      try {
        if (this.paymasterAPI instanceof TokenPaymasterAPI) {
          let mainCall: MultiSendCall = {
            to: info.target,
            value: parseNumber(info.value) ?? BigNumber.from(0),
            data: info.data
          }
          if (executeType === ExecuteType.EXECUTE_BATCH) {
            mainCall = {
              ...mainCall,
              to: getMultiSendAddress(),
              delegateCall: true,
              data: (await this.decodeExecuteDelegate(info.data) as unknown as {data: string}).data
            }
          }
          const erc20UserOp = {
            ...partialUserOp,
            callData: await this.encodeExecuteBatch([
              await this.paymasterAPI.createGasTokenApprovalRequest(this.provider),
              mainCall
            ]),
            callGasLimit: await this.provider.estimateGas({
              from: this.entryPointAddress,
              to: this.getAccountAddress(),
              data: callData
            })
          }
          paymasterResp = await this.paymasterAPI.getPaymasterResp(partialUserOp, erc20UserOp)
        } else {
          paymasterResp = await this.paymasterAPI.getPaymasterResp(partialUserOp)
        }
      } catch (err) {
        console.log('failed to get paymaster data', err)
        // if the paymaster runs into any issue, just ignore it and use
        // the account's own balance instead
      }
    }
    partialUserOp.paymasterAndData = paymasterResp?.paymasterAndData ?? '0x'

    const paymasterHasEstimates = paymasterResp?.preVerificationGas !== undefined && paymasterResp?.verificationGasLimit !== undefined && paymasterResp?.callGasLimit !== undefined

    partialUserOp.preVerificationGas = paymasterResp?.preVerificationGas ?? partialUserOp.preVerificationGas
    partialUserOp.verificationGasLimit = paymasterResp?.verificationGasLimit ?? partialUserOp.verificationGasLimit
    partialUserOp.callGasLimit = paymasterResp?.callGasLimit ?? partialUserOp.callGasLimit
    partialUserOp.callData = paymasterResp?.callData ?? partialUserOp.callData
    if (this.httpRpcClient && !paymasterHasEstimates) {
      try {
        partialUserOp.preVerificationGas = BigNumber.from('100000')
        partialUserOp.verificationGasLimit = BigNumber.from('1000000')
        const { callGasLimit, preVerificationGas, verificationGas } = await this.httpRpcClient.estimateUserOpGas(partialUserOp)

        partialUserOp.preVerificationGas = BigNumber.from(preVerificationGas).mul(12).div(10) ?? partialUserOp.preVerificationGas
        partialUserOp.verificationGasLimit = BigNumber.from(verificationGas).mul(12).div(10) ?? partialUserOp.verificationGasLimit
        partialUserOp.callGasLimit = callGasLimit ?? partialUserOp.callGasLimit
        partialUserOp.callData = paymasterResp?.callData ?? partialUserOp.callData
      } catch (_) {
      }
    }
    return {
      ...partialUserOp,
      signature: ''
    }
  }

  /**
   * Sign the filled userOp.
   * @param userOp the UserOperation to sign (with signature field ignored)
   */
  async signUserOp (userOp: UserOperationStruct): Promise<UserOperationStruct> {
    const userOpHash = await this.getUserOpHash(userOp)
    const signature = fixSignedData(await this.signUserOpHash(userOpHash))
    return {
      ...userOp,
      signature
    }
  }

  /**
   * helper method: create and sign a user operation.
   * @param info transaction details for the userOp
   */
  async createSignedUserOp (info: TransactionDetailsForUserOp, executeType: ExecuteType = ExecuteType.EXECUTE): Promise<UserOperationStruct> {
    return await this.signUserOp(await this.createUnsignedUserOp(info, executeType))
  }

  /**
   * get the transaction that has this userOpHash mined, or null if not found
   * @param userOpHash returned by sendUserOpToBundler (or by getUserOpHash..)
   * @param timeout stop waiting after this timeout
   * @param interval time to wait between polls.
   * @return the transactionHash this userOp was mined, or null if not found.
   */
  async getUserOpReceipt (userOpHash: string, timeout = 30000, interval = 5000): Promise<string | null> {
    const endtime = Date.now() + timeout
    while (Date.now() < endtime) {
      const events = await this.entryPointView.queryFilter(this.entryPointView.filters.UserOperationEvent(userOpHash))
      if (events.length > 0) {
        return events[0].transactionHash
      }
      await new Promise(resolve => setTimeout(resolve, interval))
    }
    return null
  }

  // Ethers' getFeeData function hardcodes 1.5 gwei as the minimum tip, which
  // turns out to be too large for some L2s like Arbitrum.  So we rolled our own
  // function for estimating miner tip
  async getFeeData (): Promise<FeeData> {
    const { block, gasPrice } = await resolveProperties({
      block: this.provider.getBlock('latest'),
      gasPrice: this.provider.getGasPrice().catch((error) => {
        return null
      })
    })

    let maxFeePerGas = null; let maxPriorityFeePerGas = null

    if (block && (block.baseFeePerGas != null)) {
      // Set the tip to the min of the tip for the last block and 1.5 gwei
      const minimumTip = BigNumber.from('1500000000')
      maxPriorityFeePerGas = gasPrice?.sub(block.baseFeePerGas) ?? null
      if ((maxPriorityFeePerGas == null) || maxPriorityFeePerGas.lt(0) || maxPriorityFeePerGas.gt(minimumTip)) {
        maxPriorityFeePerGas = minimumTip
      }
      maxFeePerGas = block.baseFeePerGas.mul(2).add(maxPriorityFeePerGas ?? 0)
    }

    return { maxFeePerGas, maxPriorityFeePerGas }
  }
}
