/** Tiny in-process chain on @ethereumjs/vm (Cancun) for contract tests. */
import { createBlock } from '@ethereumjs/block';
import { Common, Hardfork, Mainnet, createCustomCommon } from '@ethereumjs/common';
import { createFeeMarket1559Tx } from '@ethereumjs/tx';
import { Address, bytesToHex, createAccount, createAddressFromPrivateKey, hexToBytes } from '@ethereumjs/util';
import { createVM, runTx, type VM } from '@ethereumjs/vm';
import type { Hex } from 'viem';

export interface TxResult {
  ok: boolean;
  gasUsed: bigint;
  returnData: Hex;
  logs: { address: Hex; topics: Hex[]; data: Hex }[];
  createdAddress?: Hex;
  error?: string;
}

export interface Signer {
  pk: Uint8Array;
  address: Hex;
}

export class Chain {
  number = 100n;
  timestamp = 1_792_758_495n;
  private nonces = new Map<string, bigint>();

  private constructor(
    readonly vm: VM,
    readonly common: Common,
    readonly chainId: bigint,
  ) {}

  /** Cancun chain; `chainId` 4663 makes PonsSniper read deadlines from ArbSys (0x64). */
  static async create(opts: { chainId?: number } = {}): Promise<Chain> {
    const common = opts.chainId
      ? createCustomCommon({ chainId: opts.chainId }, Mainnet, { hardfork: Hardfork.Cancun })
      : new Common({ chain: Mainnet, hardfork: Hardfork.Cancun });
    const vm = await createVM({ common });
    return new Chain(vm, common, BigInt(opts.chainId ?? 1));
  }

  /** Install runtime code (and optionally storage slot 0) at an address, e.g. a precompile mock. */
  async putCode(address: Hex, runtime: Hex, slot0?: bigint): Promise<void> {
    const a = new Address(hexToBytes(address));
    await this.vm.stateManager.putCode(a, hexToBytes(runtime));
    if (slot0 !== undefined) {
      await this.vm.stateManager.putStorage(a, new Uint8Array(32), hexToBytes(`0x${slot0.toString(16).padStart(64, '0')}`));
    }
  }

  signer(seed: number): Signer {
    const pk = hexToBytes(`0x${seed.toString(16).padStart(64, '0')}`);
    return { pk, address: createAddressFromPrivateKey(pk).toString() as Hex };
  }

  async fund(address: Hex, wei: bigint): Promise<void> {
    const a = new Address(hexToBytes(address));
    const acct = (await this.vm.stateManager.getAccount(a)) ?? createAccount({ nonce: 0n, balance: 0n });
    acct.balance = wei;
    await this.vm.stateManager.putAccount(a, acct);
  }

  async balance(address: Hex): Promise<bigint> {
    return (await this.vm.stateManager.getAccount(new Address(hexToBytes(address))))?.balance ?? 0n;
  }

  setBlock(number: bigint, timestamp: bigint): void {
    this.number = number;
    this.timestamp = timestamp;
  }

  async send(from: Signer, tx: { to?: Hex; data?: Hex; value?: bigint; gasLimit?: bigint }): Promise<TxResult> {
    const nonce = this.nonces.get(from.address) ?? 0n;
    const signed = createFeeMarket1559Tx(
      {
        nonce,
        maxFeePerGas: 10n,
        maxPriorityFeePerGas: 0n,
        gasLimit: tx.gasLimit ?? 3_000_000n,
        ...(tx.to ? { to: tx.to } : {}),
        value: tx.value ?? 0n,
        data: tx.data ?? '0x',
        chainId: this.chainId,
      },
      { common: this.common },
    ).sign(from.pk);
    const block = createBlock(
      { header: { number: this.number, timestamp: this.timestamp, gasLimit: 30_000_000n, baseFeePerGas: 1n } },
      { common: this.common },
    );
    const r = await runTx(this.vm, { tx: signed, block, skipBlockGasLimitValidation: true });
    this.nonces.set(from.address, nonce + 1n);
    const err = r.execResult.exceptionError;
    return {
      ok: !err,
      gasUsed: r.totalGasSpent,
      returnData: bytesToHex(r.execResult.returnValue) as Hex,
      logs: (r.execResult.logs ?? []).map(([addr, topics, data]) => ({
        address: bytesToHex(addr) as Hex,
        topics: topics.map((t) => bytesToHex(t) as Hex),
        data: bytesToHex(data) as Hex,
      })),
      ...(r.createdAddress ? { createdAddress: r.createdAddress.toString() as Hex } : {}),
      ...(err ? { error: err.error } : {}),
    };
  }

  /** eth_call-like read (no state commit). */
  async call(to: Hex, data: Hex, from?: Hex): Promise<Hex> {
    const vm = await this.vm.shallowCopy();
    const block = createBlock(
      { header: { number: this.number, timestamp: this.timestamp, gasLimit: 30_000_000n, baseFeePerGas: 1n } },
      { common: this.common },
    );
    const r = await vm.evm.runCall({
      to: new Address(hexToBytes(to)),
      ...(from ? { caller: new Address(hexToBytes(from)) } : {}),
      data: hexToBytes(data),
      gasLimit: 10_000_000n,
      block,
    });
    if (r.execResult.exceptionError) throw new Error(`call reverted: ${r.execResult.exceptionError.error}`);
    return bytesToHex(r.execResult.returnValue) as Hex;
  }
}
