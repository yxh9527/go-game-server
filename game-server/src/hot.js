import fs from "node:fs";
import { pathToFileURL } from "node:url";

export function watchHot({ dir, extraDirs = [], entry, skip, onReload, log }) {
  let timer = null;
  let loading = false;
  let pending = false;

  async function reload(reason) {
    if (loading) {
      pending = true;
      return;
    }
    loading = true;
    const version = Date.now();
    const url = pathToFileURL(entry).href + `?v=${version}`;
    try {
      const mod = await import(url);
      await onReload(mod, version, reason);
    } catch (err) {
      log.error("hot reload failed, keep previous module", err);
    } finally {
      loading = false;
      if (pending) {
        pending = false;
        reload("queued");
      }
    }
  }

  for (const watchedDir of [dir, ...extraDirs]) {
    fs.watch(watchedDir, { recursive: true }, (_event, filename) => {
      if (!filename) {
        return;
      }
      const rel = String(filename).replaceAll("\\", "/");
      if (skip && skip(rel)) {
        return;
      }
      if (!rel.endsWith(".js")) {
        return;
      }
      clearTimeout(timer);
      timer = setTimeout(() => reload(rel), 150);
    });
  }

  return reload;
}
