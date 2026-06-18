import type { HarnessPort } from './harness-port.js';

export class NoopHarness implements HarnessPort {
  async shouldCreate(): Promise<boolean> {
    return false;
  }
}
