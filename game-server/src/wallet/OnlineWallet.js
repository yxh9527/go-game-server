import { WalletAdapter } from './WalletAdapter.js';
import { createRpcWallet } from './rpcWallet.js';
import { rpcService } from '../../../shared/rpc/index.js';

export class OnlineWallet extends WalletAdapter {
  constructor(options = {}) {
    super(options);
    this.rpc = options.rpc;
  }

  get mode() {
    return "online";
  }

  #adapter() {
    const rpc=this.rpc||rpcService;
    if(!rpc?.common)throw new Error('Online wallet requires the data-center RPC adapter');
    return createRpcWallet(rpc);
  }
  load(session) {
    return this.#adapter().load(session);
  }
  debit(session, amount) {
    return this.#adapter().debit(session,amount);
  }
  credit(session, amount) {
    return this.#adapter().credit(session,amount);
  }
  persist(session) {
    return this.#adapter().persist(session);
  }
}
