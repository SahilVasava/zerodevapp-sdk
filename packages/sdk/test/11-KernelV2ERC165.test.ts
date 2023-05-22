import { SampleRecipient, SampleRecipient__factory, TestERC721__factory } from '@account-abstraction/utils/dist/src/types'
import { ethers } from 'hardhat'
import { ZeroDevProvider, AssetType } from '../src'
import { resolveProperties, parseEther, hexValue } from 'ethers/lib/utils'
import { verifyMessage } from '@ambire/signature-validator'
import {
  MultiSend__factory,
} from '@zerodevapp/contracts'
import { expect } from 'chai'
import { Signer, Wallet } from 'ethers'
import { anyValue } from '@nomicfoundation/hardhat-chai-matchers/withArgs'
import { ClientConfig } from '../src/ClientConfig'
import { wrapProvider, wrapV2Provider } from '../src/Provider'
import { DeterministicDeployer } from '../src/DeterministicDeployer'
import { MockERC1155__factory, MockERC20__factory, MockERC721__factory } from '../typechain-types'
import { setMultiSendAddress } from '../src/multisend'
import {
  ECDSAKernelFactory,
  ECDSAValidator__factory,
  EntryPoint, EntryPoint__factory,
  Kernel, Kernel__factory,
  KernelFactory, KernelFactory__factory,
  ECDSAValidator, ECDSAKernelFactory__factory,
  ERC165SessionKeyValidator, ERC165SessionKeyValidator__factory, ERC721Actions, ERC721Actions__factory,
} from '@zerodevapp/kernel-contracts-v2'
import { KernelAccountV2API } from '../src/KernelAccountV2API'
import {
  ECDSAValidator as ECDSAValidatorAPI,
  ERC165SessionKeyValidator as ERC165SessionKeyValidatorAPI,
  ValidatorMode
} from '../src/validators'

const provider = ethers.provider
const signer = provider.getSigner()
const deployer = new DeterministicDeployer(ethers.provider)

describe.only('KernelV2 ERC165SessionKey validator', function () {
  let recipient: SampleRecipient
  let aaProvider: ZeroDevProvider
  let entryPoint: EntryPoint
  let kernelFactory: KernelFactory
  let accountFactory: ECDSAKernelFactory
  let ecdsaValidator: ECDSAValidatorAPI
  let validator: ERC165SessionKeyValidator
  let sessionKey: Signer
  let action : ERC721Actions
  let validatorAPI : ERC165SessionKeyValidatorAPI
  let owner : Signer

  // create an AA provider for testing that bypasses the bundler
  let createTestAAProvider = async (owner: Signer, address?: string): Promise<ZeroDevProvider> => {
    const config: ClientConfig = {
      entryPointAddress: entryPoint.address,
      implementation: {
        accountAPIClass: KernelAccountV2API,
        factoryAddress: kernelFactory.address,
      },
      walletAddress: address,
      bundlerUrl: '',
      projectId: '',
      validatorAddress: validator.address
    }
    const aaProvider = await wrapV2Provider(provider, config, owner, ecdsaValidator, validatorAPI)
    const beneficiary = provider.getSigner().getAddress()
    // for testing: bypass sending through a bundler, and send directly to our entrypoint..
    aaProvider.httpRpcClient.sendUserOpToBundler = async (userOp) => {
      try {
        console.log("SIG : ", userOp.signature);
        const tx = await entryPoint.handleOps([userOp], beneficiary)
        const rcpt = await tx.wait();
        rcpt.events!.forEach(e => console.log(e.event))
        rcpt.events!.filter(e => e.event === "UserOperationEvent").forEach(e => console.log(e.args))
      } catch (e: any) {
        // doesn't report error unless called with callStatic
        await entryPoint.callStatic.handleOps([userOp], beneficiary).catch((e: any) => {
          // eslint-disable-next-line
          const message = e.errorArgs != null ? `${e.errorName}(${e.errorArgs.join(',')})` : e.message
          throw new Error(message)
        })
      }
      return ''
    }

    aaProvider.httpRpcClient.estimateUserOpGas = async (userOp) => {
      const op = {
        ...await resolveProperties(userOp),
        // default values for missing fields.
        paymasterAndData: '0x',
        signature: '0x'.padEnd(66 * 2, '1b'), // TODO: each wallet has to put in a signature in the correct length
        maxFeePerGas: 0,
        maxPriorityFeePerGas: 0,
        preVerificationGas: 0,
        verificationGasLimit: 10e6
      }
      const callGasLimit = await provider.estimateGas({
        from: entryPoint.address,
        to: userOp.sender,
        data: userOp.callData
      }).then(b => b.toNumber())

      return {
        preVerificationGas: '1000000',
        verificationGas: '1000000',
        callGasLimit: '1000000',
        validUntil: 0,
        validAfter: 0
      }
    }
    return aaProvider
  }

  describe('wallet created with zerodev', function () {
    before('init', async () => {
      action = await new ERC721Actions__factory(signer).deploy()
      entryPoint = await new EntryPoint__factory(signer).deploy()
      kernelFactory = await new KernelFactory__factory(signer).deploy(entryPoint.address)
      validator = await new ERC165SessionKeyValidator__factory(signer).deploy()
      const defaultValidator = await new ECDSAValidator__factory(signer).deploy()
      console.log("Default validator : ", defaultValidator.address);
      accountFactory = await new ECDSAKernelFactory__factory(signer).deploy(kernelFactory.address, defaultValidator.address)
      owner = Wallet.createRandom()
      sessionKey = Wallet.createRandom()
      ecdsaValidator = new ECDSAValidatorAPI({
        entrypoint: entryPoint,
        mode : ValidatorMode.sudo,
        kernelValidator: await accountFactory.validator(),
        owner: owner,
      })
      console.log("ecdsa validator : ", ecdsaValidator.getAddress());
      validatorAPI = new ERC165SessionKeyValidatorAPI({
        entrypoint: entryPoint,
        mode : ValidatorMode.plugin,
        kernelValidator: validator.address,
        sessionKey : sessionKey,
        erc165InterfaceId : '0x80ac58cd',
        selector: action.interface.getSighash("transferERC721Action"),
        executor: action.address,
        addressOffset: 16
      });
      aaProvider = await createTestAAProvider(owner)
      const accountAddress = await aaProvider.getSigner().getAddress()
      const enableSig = await ecdsaValidator.approveExecutor(accountAddress, action.interface.getSighash("transferERC721Action"), action.address, 0, 0, validatorAPI)
      console.log("Approved")
      validatorAPI.setEnableSignature(enableSig)
    })
    it('should use ERC-4337 Signer and Provider to send the UserOperation to the bundler', async function () {
      const accountAddress = await aaProvider.getSigner().getAddress()
      console.log("accountAddress", accountAddress)
      await signer.sendTransaction({
        to: accountAddress,
        value: parseEther('0.1')
      })
      
      const zdSigner = aaProvider.getSigner();

      const randomWallet = Wallet.createRandom()
      console.log("randomWallet", randomWallet.address)

      const action = ERC721Actions__factory.connect(accountAddress, zdSigner);
      const testToken = await new TestERC721__factory(signer).deploy()
      await testToken.mint(accountAddress, 0)
      const res = await action.connect(entryPoint.address).callStatic.transferERC721Action(testToken.address, 0, randomWallet.address)
      console.log("res: ",res)
      console.log("owner of token 0", await testToken.ownerOf(0))
      await action.transferERC721Action(testToken.address, 0, randomWallet.address)
      console.log("owner of token 0", await testToken.ownerOf(0))
    })
  })
})
