import { loadConfig, type LoadedConfig } from './core/config.js';
import { OpsService } from './core/service.js';
import { LiveAmazonApi } from './api/amazon.js';
import { MockAmazonApi } from './api/mock.js';
import { Store } from './utils/store.js';

export function createService({ config, root }: LoadedConfig): OpsService {
  const store = new Store(root, config.stateDirectory, config.mode);
  const api = config.mode === 'mock'
    ? new MockAmazonApi(config, async () => Object.values((await store.read()).plans))
    : new LiveAmazonApi(config);
  return new OpsService(config, root, store, api);
}

export async function loadService(configPath?: string): Promise<OpsService> {
  return createService(await loadConfig(configPath));
}
