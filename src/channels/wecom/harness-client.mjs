import { HarnessClient as SharedHarnessClient } from '../shared/harness-client.mjs';

export class WecomHarnessClient extends SharedHarnessClient {
  constructor(options) {
    super({ ...options, rpcPrefix: options.rpcPrefix ?? 'wecom' });
  }
}
