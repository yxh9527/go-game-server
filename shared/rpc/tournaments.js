import { createDataCenterStore } from './implementations/prod/dataCenterStore.js';
import { createRequire } from 'node:module';
const require = createRequire(import.meta.url);

// Tournament-specific persistence remains behind the unified RPC boundary.
export function tournamentStore(runtime) {
  if (runtime.env === 'dev') {
    const { createDevTournamentStore } = require('../../cache/match/store.js');
    return createDevTournamentStore(runtime);
  }
  return createDataCenterStore();
}
