/**
 * `agentbox prepare --provider devvm`: bake the base snapshot every box starts
 * from. A builder VM is made from devvm's own image, the box runtime is copied
 * in (the shared assets from the running AgentBox CLI, plus this package's
 * install-box.sh and CLAUDE.md), the installer runs as root, the host's agent
 * config is staged in, and the VM is saved as a devvm snapshot. The builder is
 * then removed; the snapshot stays.
 */

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computeContextSha256,
  readCliStamp,
  readPreparedStateRaw,
  resolveSharedRuntimeAsset,
  stageAllAgentStatic,
  UserFacingError,
  writePreparedStateRaw,
  preparedStatePathFor,
  type Provider,
} from '@madarco/agentbox-provider-sdk';
import { BACKEND_NAME, makeVm, removeVm, rootExec } from './backend.js';
import { builderFolder, devvm, parseSnapshots, shq, snapshotListArgs, snapshotRmArgs, snapshotSaveArgs } from './devvm.js';

const SELF = dirname(fileURLToPath(import.meta.url));

function vendored(basename: string): string {
  const candidates = [resolve(SELF, '..', 'scripts', basename), resolve(SELF, 'scripts', basename)];
  const hit = candidates.find((path) => existsSync(path));
  if (!hit) throw new Error(`devvm provider: its ${basename} is missing (tried ${candidates.join(', ')}).`);
  return hit;
}

export interface RuntimeAsset {
  name: string;
  remotePath: string;
  mode: number;
  source: { shared: string } | { vendored: string };
}

/** What `prepare` copies into the builder; install-box.sh reads these fixed paths. */
export const RUNTIME_ASSETS: readonly RuntimeAsset[] = [
  { name: 'install-box.sh', remotePath: '/tmp/agentbox-install.sh', mode: 0o755, source: { vendored: 'install-box.sh' } },
  { name: 'agentbox-ctl', remotePath: '/tmp/agentbox-ctl', mode: 0o755, source: { shared: 'ctl.cjs' } },
  { name: 'agentbox-checkpoint-cleanup', remotePath: '/tmp/agentbox-checkpoint-cleanup', mode: 0o755, source: { shared: 'agentbox-checkpoint-cleanup' } },
  { name: 'agentbox-open', remotePath: '/tmp/agentbox-open', mode: 0o755, source: { shared: 'agentbox-open' } },
  { name: 'gh-shim', remotePath: '/tmp/agentbox-gh-shim', mode: 0o755, source: { shared: 'gh-shim' } },
  { name: 'git-shim', remotePath: '/tmp/agentbox-git-shim', mode: 0o755, source: { shared: 'git-shim' } },
  { name: 'agentbox-tool-shim', remotePath: '/tmp/agentbox-tool-shim', mode: 0o755, source: { shared: 'agentbox-tool-shim' } },
  { name: 'custom-system-CLAUDE.md', remotePath: '/tmp/agentbox-custom-CLAUDE.md', mode: 0o644, source: { vendored: 'custom-system-CLAUDE.md' } },
  { name: 'claude-managed-settings.json', remotePath: '/tmp/agentbox-managed-settings.json', mode: 0o644, source: { shared: 'claude-managed-settings.json' } },
  { name: 'agentbox-codex-hooks.json', remotePath: '/tmp/agentbox-codex-hooks.json', mode: 0o644, source: { shared: 'agentbox-codex-hooks.json' } },
  { name: 'agentbox-setup-skill.md', remotePath: '/tmp/agentbox-setup-skill.md', mode: 0o644, source: { shared: 'agentbox-setup-skill.md' } },
  { name: 'agentbox-identity-skill.md', remotePath: '/tmp/agentbox-identity-skill.md', mode: 0o644, source: { shared: 'agentbox-identity-skill.md' } },
];

export function resolveRuntimeAssets(): Array<RuntimeAsset & { localPath: string }> {
  return RUNTIME_ASSETS.map((asset) => ({
    ...asset,
    localPath:
      'shared' in asset.source
        ? resolveSharedRuntimeAsset(asset.source.shared)
        : vendored(asset.source.vendored),
  }));
}

export interface PreparedBase {
  /** The devvm snapshot ID boxes start from. */
  snapshotId: string;
  contextSha256: string;
  cliVersion?: string;
  createdAt: string;
}

interface PreparedState {
  schema: 1;
  base?: PreparedBase;
}

export function readPrepared(): PreparedState {
  const raw = readPreparedStateRaw(BACKEND_NAME) as Partial<PreparedState> | null;
  if (!raw || raw.schema !== 1) return { schema: 1 };
  return { schema: 1, base: raw.base };
}

/** The base snapshot's ID for a build context: `ab-<10 hex>` (13 characters, see devvm.ts). */
export function baseSnapshotId(contextSha: string): string {
  return `ab-${contextSha.slice(0, 10)}`;
}

/** The base snapshot every create starts from; a clear error until `prepare` has run. */
export function requireBaseSnapshot(): string {
  const base = readPrepared().base;
  if (!base) {
    throw new UserFacingError(
      'The devvm provider has no base snapshot yet. Run `agentbox prepare --provider devvm` first.',
    );
  }
  return base.snapshotId;
}

export async function currentFingerprint(): Promise<string | undefined> {
  try {
    const assets = resolveRuntimeAssets();
    return await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath })));
  } catch {
    return undefined;
  }
}

const INSTALL_TIMEOUT_MS = 40 * 60_000;

export const prepareDevvm: NonNullable<Provider['prepare']> = async (req) => {
  const log = req.onLog ?? (() => {});
  const progress = (line: string) => log(`prepare-devvm: ${line}`);
  const assets = resolveRuntimeAssets();
  const contextSha = await computeContextSha256(assets.map((a) => ({ rel: a.name, abs: a.localPath })));
  const id = baseSnapshotId(contextSha);

  const existing = readPrepared().base;
  const snapshots = parseSnapshots(await devvm(snapshotListArgs()));
  if (!req.force && existing?.snapshotId === id && snapshots.includes(id)) {
    progress(`base snapshot ${id} is up to date; nothing to do (--force bakes it again)`);
    return { snapshotName: id };
  }

  const folder = builderFolder();
  progress('making the builder VM (the first one also builds devvm\'s image)');
  const vm = await makeVm(folder, { cpu: 4, memory: 4 });
  try {
    progress(`copying ${assets.length} runtime files in`);
    for (const asset of assets) {
      const data = await readFile(asset.localPath);
      const result = await rootExec(
        vm,
        ['sh', '-c', `cat > ${shq(asset.remotePath)} && chmod ${asset.mode.toString(8)} ${shq(asset.remotePath)}`],
        { input: data, timeoutMs: 60_000 },
      );
      if (result.exitCode !== 0) throw new Error(`Could not copy ${asset.name} in: ${result.stderr.trim()}`);
    }

    progress('running install-box.sh (a few minutes)');
    const install = await rootExec(vm, ['bash', '/tmp/agentbox-install.sh'], {
      timeoutMs: INSTALL_TIMEOUT_MS,
      onLine: (line) => log(`[install] ${line}`),
    });
    if (install.exitCode !== 0) {
      throw new Error(`install-box.sh failed in the builder VM (exit ${install.exitCode}).`);
    }

    progress('staging this computer\'s agent config');
    for (const stage of await stageAllAgentStatic({ hostWorkspace: req.hostWorkspace })) {
      for (const warning of stage.staged.warnings) progress(warning);
      try {
        if (!stage.staged.tarballPath) continue;
        const tar = await readFile(stage.staged.tarballPath);
        const dest = shq(stage.extractDir);
        const result = await rootExec(
          vm,
          [
            'sh',
            '-c',
            `sudo -u vscode -H mkdir -p ${dest} && sudo -u vscode -H tar -xzf - -C ${dest} --no-same-permissions --no-same-owner -m`,
          ],
          { input: tar, timeoutMs: 300_000 },
        );
        progress(
          result.exitCode === 0
            ? `baked ${stage.kind} config`
            : `${stage.kind} config did not unpack (exit ${result.exitCode}); continuing`,
        );
      } finally {
        await stage.staged.cleanup();
      }
    }

    if (snapshots.includes(id)) await devvm(snapshotRmArgs(id));
    progress(`saving the base snapshot ${id}`);
    await devvm(snapshotSaveArgs(vm, id), { timeoutMs: 300_000 });
  } finally {
    progress('removing the builder VM');
    await removeVm(vm, folder).catch((err: unknown) =>
      progress(`the builder VM ${vm} was not removed: ${(err as Error).message}`),
    );
  }

  const previous = existing?.snapshotId;
  writePreparedStateRaw(BACKEND_NAME, {
    schema: 1,
    base: {
      snapshotId: id,
      contextSha256: contextSha,
      cliVersion: readCliStamp().cliVersion,
      createdAt: new Date().toISOString(),
    },
  } satisfies PreparedState);
  progress(`wrote ${preparedStatePathFor(BACKEND_NAME)}`);
  if (previous && previous !== id) {
    // Boxes made from the old base keep running: a devvm clone does not depend on its source.
    await devvm(snapshotRmArgs(previous)).catch(() => undefined);
  }
  progress(`prepare complete: base snapshot ${id}`);
  return { snapshotName: id };
};
