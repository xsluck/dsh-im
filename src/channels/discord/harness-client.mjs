import { HarnessClient as SharedHarnessClient } from '../shared/harness-client.mjs';

export class DiscordHarnessClient extends SharedHarnessClient {
  constructor(options) {
    super({ ...options, rpcPrefix: options.rpcPrefix ?? 'discord' });
  }
}
