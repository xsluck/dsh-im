import { HarnessClient as SharedHarnessClient } from '../shared/harness-client.mjs';

export class SlackHarnessClient extends SharedHarnessClient {
  constructor(options) {
    super({ ...options, rpcPrefix: options.rpcPrefix ?? 'slack' });
  }
}
