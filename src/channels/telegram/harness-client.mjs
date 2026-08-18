import { HarnessClient as SharedHarnessClient } from '../shared/harness-client.mjs';

export class TelegramHarnessClient extends SharedHarnessClient {
  constructor(options) {
    super({ ...options, rpcPrefix: options.rpcPrefix ?? 'telegram' });
  }
}
