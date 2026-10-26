import fs from "node:fs";

// Only dev's immutable room seeds are replaced. Wallets, matches and resident
// tables remain owned by their existing stores during business hot updates.
export async function refreshRoomConfigs(runtime) {
  const store = runtime.rpc?.lobby?.store;
  if (!store) return; // Injected test/online adapters keep their own config source.
  const file = new URL('./seed.js', import.meta.url);
  const refresh = async () => {
    const version = fs.statSync(file).mtimeMs;
    const { seedRooms } = await import(file.href + '?v=' + version);
    store.listRooms = async () => seedRooms();
    const rows = await store.listRooms();
    if (runtime.roomStore) runtime.roomStore.replace(rows);
    if (Array.isArray(runtime.configs)) runtime.configs = rows;
  };
  await refresh();
  if (!runtime.devRoomConfigWatcher) {
    const watcher = fs.watch(file, () => {
      refresh().catch((error) => runtime.log?.error?.('reload dev room seeds failed', error));
    });
    watcher.unref();
    runtime.devRoomConfigWatcher = watcher;
  }
}
