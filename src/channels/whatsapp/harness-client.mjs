import { HarnessClient as SharedHarnessClient } from '../shared/harness-client.mjs';

export class WhatsappHarnessClient extends SharedHarnessClient {
  constructor(options) {
    super({ ...options, rpcPrefix: options.rpcPrefix ?? 'whatsapp' });
  }
}
