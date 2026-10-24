import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import test from "node:test";
import yaml from "js-yaml";
import { buildProduction, isProductionPath } from "../../scripts/build-prod.js";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
test("business trees contain no tests or static cache imports", async () => {
  for (const directory of ["shared", "hall/src", "game-server/src", "match/src", "client-web/src"]) {
    for (const file of await fs.readdir(path.join(root, directory), { recursive: true })) {
      assert.doesNotMatch(file, /\.(test|spec)\.[cm]?js$/);
      if (!file.endsWith(".js")) continue;
      const source = await fs.readFile(path.join(root, directory, file), "utf8");
      assert.doesNotMatch(source, /(?:from\s*|import\s*)["'][^"']*\/(?:test|cache)\//, directory + "/" + file);
    }
  }
});

test("production filter excludes development files but retains runtime caches and robot logic", () => {
  for (const file of ["test/hall/a.test.js", "cache/rpc/store.js", "hall/src/a.test.js", "static/.git/config", "static/.tmp-debug.js", "game-server/src/example.spec.mjs"]) {
    assert.equal(isProductionPath(file), false, file);
  }
  for (const file of ["game-server/src/record-cache.js", "game-server/src/core/room-features.js", "game-server/src/core/robot.js", "shared/rpc/implementations/prod/busRpcProd.js"]) {
    assert.equal(isProductionPath(file), true, file);
  }
});

test("actual production bundle loads without test/cache and never falls back to dev", async () => {
  const outputDir = path.join(root, "dist", "test-production-" + process.pid);
  try {
    await buildProduction({ outputDir, includeStatic: false });
    const manifest = JSON.parse(await fs.readFile(path.join(outputDir, "build-manifest.json"), "utf8"));
    assert.ok(manifest.files.every(isProductionPath));
    assert.equal(manifest.files.some(file => file.startsWith("cache/") || file.startsWith("test/")), false);
    for (const service of ["hall", "game-server", "match"]) {
      const config = yaml.load(await fs.readFile(path.join(outputDir, service, "config.yaml"), "utf8"));
      assert.equal(config.env, "prod");
      if (config.wallet) {
        assert.equal(config.wallet.mode, "online");
        assert.equal(config.wallet.local_balance, undefined);
      }
    }
    const pkg = JSON.parse(await fs.readFile(path.join(outputDir, "package.json"), "utf8"));
    assert.equal(pkg.scripts.dev, undefined);
    assert.equal(pkg.scripts.test, undefined);
    const lock = JSON.parse(await fs.readFile(path.join(outputDir, "package-lock.json"), "utf8"));
    assert.deepEqual(lock.packages[""].workspaces, pkg.workspaces);
    for (const service of pkg.workspaces) assert.ok(lock.packages[service]);
    for (const file of ["static/hall/21/0/index.html", "static/client/2.0.1279/index.html"]) {
      await fs.mkdir(path.dirname(path.join(outputDir, file)), { recursive: true });
      await fs.writeFile(path.join(outputDir, file), "<!doctype html><head></head><body>production fixture</body>");
    }
    const result = spawnSync(process.execPath, [path.join(root, "test/fixtures/production-smoke.mjs"), outputDir], {
      cwd: outputDir, encoding: "utf8", timeout: 20000,
      env: { ...process.env, NODE_ENV: "production", GOGAME_ENV: "prod", IS_DEV: "0" }, windowsHide: true,
    });
    assert.equal(result.status, 0, result.stdout + result.stderr);
  } finally {
    // This exact path is a disposable build created by this test.
    await fs.rm(outputDir, { recursive: true, force: true });
  }
});

test("builder refuses source-tree and unmarked output paths", async () => {
  await assert.rejects(buildProduction({ outputDir: path.join(root, "hall"), includeStatic: false }), /child/);
  const target = path.join(root, "dist", "test-unmarked-" + process.pid);
  await fs.mkdir(target, { recursive: true });
  await fs.writeFile(path.join(target, "keep.txt"), "keep");
  try {
    await assert.rejects(buildProduction({ outputDir: target, includeStatic: false }));
    assert.equal(await fs.readFile(path.join(target, "keep.txt"), "utf8"), "keep");
  } finally { await fs.rm(target, { recursive: true, force: true }); }
});
