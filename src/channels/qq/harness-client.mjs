import { HarnessClient as SharedHarnessClient } from '../shared/harness-client.mjs';

export class QqHarnessClient extends SharedHarnessClient {
  constructor(options) {
    super({ ...options, rpcPrefix: options.rpcPrefix ?? 'qq' });
  }
}
