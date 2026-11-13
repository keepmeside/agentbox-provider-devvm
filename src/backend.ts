/**
 * The `devvm` CloudBackend: each box is a devvm VM (one Lima VM per folder)
 * made from the base snapshot `prepare` baked. Every call goes through Stella's
 * devvm fork: `create --from-snapshot`, `start`/`stop`/`rm --vm`, `exec --vm`
 * (as root, then `sudo -u vscode`), `forward --vm` for preview URLs (a free
 * loopback port per box and guest port), `snapshot save/rm` for checkpoints.
 */

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type {
  CloudBackend,
  CloudExecOptions,
  CloudExecResult,
  CloudFileEntry,
  CloudHandle,
  CloudPreviewUrl,
  CloudProvisionRequest,
  CloudSandboxSummary,
  CloudState,
} from '@madarco/agentbox-provider-sdk';
import {
  boxFolder,
  boxShell,
  boxesRoot,
  cloudState,
  createArgs,
  devvm,
  execArgs,
  forwardArgs,
  forwardCloseArgs,
  lsArgs,
  parseCreate,
  parseForward,
  parseLs,
  parseSnapshots,
  rmArgs,
  runDevvm,
  shq,
  snapshotId,
  snapshotListArgs,
  snapshotRmArgs,
  snapshotSaveArgs,
  startArgs,
  stopArgs,
  type DevvmVm,
} from './devvm.js';

export const BACKEND_NAME = 'devvm';

/**
 * devvm's measured times: create from a snapshot ~20 s, start ~8 s, stop ~2 s. A create with no
 * snapshot (the `prepare` builder) may first download Ubuntu's image and build devvm's own, which
 * devvm bounds itself; it gets the installer's ceiling.
 */
const CREATE_TIMEOUT_MS = 600_000;
const FIRST_CREATE_TIMEOUT_MS = 40 * 60_000;
const START_TIMEOUT_MS = 180_000;
const QUICK_TIMEOUT_MS = 60_000;
const EXEC_TIMEOUT_MS = 30 * 60_000;

/** What a box needs beyond its VM name: devvm's ssh config and the VM's alias in it (attach). */
export interface BoxSsh {
  config: string;
  host: string;
}

function handlesDir(): string {
  return join(boxesRoot(), 'handles');
}

async function writeSsh(vm: string, ssh: BoxSsh): Promise<void> {
  await mkdir(handlesDir(), { recursive: true });
  await writeFile(join(handlesDir(), `${vm}.json`), JSON.stringify(ssh));
}

export async function readSsh(vm: string): Promise<BoxSsh | null> {
  try {
    return JSON.parse(await readFile(join(handlesDir(), `${vm}.json`), 'utf8')) as BoxSsh;
  } catch {
    return null;
  }
}

export async function listVms(): Promise<DevvmVm[]> {
  return parseLs(await devvm(lsArgs(), { timeoutMs: QUICK_TIMEOUT_MS }), boxesRoot());
}

async function findVm(vm: string): Promise<DevvmVm | undefined> {
  return (await listVms()).find((entry) => entry.name === vm);
}

/** Makes a VM in `folder` from `snapshot`; returns its name after recording its ssh alias. */
export async function makeVm(
  folder: string,
  opts: { snapshot?: string; cpu?: number; memory?: number; onLog?: (line: string) => void },
): Promise<string> {
  // devvm's `create` starts a folder's VM when it already has one: a box always starts fresh.
  const stale = (await listVms()).find((vm) => vm.folder === folder);
  if (stale) {
    throw new Error(
      `A devvm VM (${stale.name}) is left over in ${folder}. Remove it with \`agentbox prune --provider devvm\` (or \`devvm rm --vm ${stale.name} --force\`), then try again.`,
    );
  }
  await mkdir(folder, { recursive: true });
  try {
    const out = await devvm(createArgs(opts), {
      cwd: folder,
      timeoutMs: opts.snapshot ? CREATE_TIMEOUT_MS : FIRST_CREATE_TIMEOUT_MS,
      onLine: opts.onLog,
    });
    const vm = parseCreate(out);
    await writeSsh(vm.name, vm.ssh);
    return vm.name;
  } catch (err) {
    // A half-made VM and its folder never outlive a failed create.
    const made = await listVms().catch(() => []);
    for (const vm of made.filter((entry) => entry.folder === folder)) {
      await devvm(rmArgs(vm.name), { timeoutMs: QUICK_TIMEOUT_MS }).catch(() => undefined);
    }
    await rm(folder, { recursive: true, force: true });
    throw err;
  }
}

/**
 * Deletes the VM, its folder and its record. A VM devvm no longer lists is already gone; a listing
 * that fails is an error, so a box is never forgotten while its VM still runs.
 */
export async function removeVm(vm: string, folder?: string): Promise<void> {
  const known = await findVm(vm);
  if (known) await devvm(rmArgs(vm), { timeoutMs: QUICK_TIMEOUT_MS });
  const dir = folder ?? known?.folder;
  if (dir && dir.startsWith(`${boxesRoot()}/`)) await rm(dir, { recursive: true, force: true });
  await rm(join(handlesDir(), `${vm}.json`), { force: true });
}

/** Runs `argv` as root in the VM. */
export function rootExec(
  vm: string,
  argv: string[],
  opts: { input?: Buffer | string; timeoutMs?: number; onLine?: (line: string) => void } = {},
) {
  return runDevvm(execArgs(vm, argv, opts.input !== undefined), {
    input: opts.input,
    timeoutMs: opts.timeoutMs ?? EXEC_TIMEOUT_MS,
    onLine: opts.onLine,
  });
}

export const devvmBackend: CloudBackend = {
  name: BACKEND_NAME,
  // The guest's own user has passwordless sudo; files staged into the box go
  // through root so their owner can be handed to vscode.
  stageFilesAsRoot: true,

  async provision(req: CloudProvisionRequest): Promise<CloudHandle> {
    // `image` is the base snapshot (`provisionImage`); `snapshot` a checkpoint.
    const snapshot = req.snapshot ?? req.image;
    const vm = await makeVm(boxFolder(req.name), {
      snapshot,
      cpu: req.resources?.cpu,
      memory: req.resources?.memory,
      onLog: req.onLog,
    });
    if (req.env && Object.keys(req.env).length > 0) {
      const lines = Object.entries(req.env)
        .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
        .map(([key, value]) => `${key}=${shq(value)}`)
        .join('\n');
      await rootExec(vm, ['sh', '-c', 'mkdir -p /etc/agentbox && cat >> /etc/agentbox/box.env'], {
        input: `${lines}\n`,
        timeoutMs: QUICK_TIMEOUT_MS,
      });
    }
    return { sandboxId: vm, resources: req.resources };
  },

  async get(sandboxId: string): Promise<CloudHandle | null> {
    return (await findVm(sandboxId)) ? { sandboxId } : null;
  },

  async list(): Promise<CloudSandboxSummary[]> {
    return (await listVms()).map((vm) => ({
      sandboxId: vm.name,
      name: vm.name,
      state: cloudState(vm.status),
    }));
  },

  async start(h) {
    await devvm(startArgs(h.sandboxId), { timeoutMs: START_TIMEOUT_MS });
  },
  async stop(h) {
    await devvm(stopArgs(h.sandboxId), { timeoutMs: QUICK_TIMEOUT_MS });
  },
  // A VM has no freeze: pause stops it (pauseSemantics 'stop').
  async pause(h) {
    await devvm(stopArgs(h.sandboxId), { timeoutMs: QUICK_TIMEOUT_MS });
  },
  async resume(h) {
    await devvm(startArgs(h.sandboxId), { timeoutMs: START_TIMEOUT_MS });
  },

  async destroy(h) {
    await removeVm(h.sandboxId);
  },

  async state(h): Promise<CloudState> {
    const vm = await findVm(h.sandboxId);
    return vm ? cloudState(vm.status) : 'missing';
  },

  async exec(h, cmd: string, opts?: CloudExecOptions): Promise<CloudExecResult> {
    const result = await rootExec(h.sandboxId, boxShell(cmd, opts ?? {}), {
      timeoutMs: opts?.attemptTimeoutMs ?? EXEC_TIMEOUT_MS,
    });
    return { exitCode: result.exitCode, stdout: result.stdout, stderr: result.stderr };
  },

  async uploadFile(h, localPath: string, remotePath: string) {
    const data = await readFile(localPath);
    const dir = dirname(remotePath);
    const script =
      `mkdir -p ${shq(dir)} && cat > ${shq(remotePath)} && ` +
      `if id vscode >/dev/null 2>&1; then chown vscode:vscode ${shq(remotePath)}; fi`;
    const result = await rootExec(h.sandboxId, ['sh', '-c', script], { input: data });
    if (result.exitCode !== 0) {
      throw new Error(`Could not copy ${localPath} into the box: ${result.stderr.trim()}`);
    }
  },

  async downloadFile(h, remotePath: string, localPath: string) {
    await mkdir(dirname(localPath), { recursive: true });
    const result = await runDevvm(execArgs(h.sandboxId, ['cat', remotePath]), {
      toFile: localPath,
      timeoutMs: EXEC_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) {
      await rm(localPath, { force: true });
      throw new Error(`Could not copy ${remotePath} out of the box: ${result.stderr.trim()}`);
    }
  },

  async listFiles(h, remoteDir: string): Promise<CloudFileEntry[]> {
    const result = await rootExec(
      h.sandboxId,
      ['find', remoteDir, '-mindepth', '1', '-maxdepth', '1', '-printf', '%y\\t%f\\n'],
      { timeoutMs: QUICK_TIMEOUT_MS },
    );
    if (result.exitCode !== 0) return [];
    return parseFindListing(result.stdout);
  },

  async previewUrl(h, port: number): Promise<CloudPreviewUrl> {
    const fwd = parseForward(
      await devvm(forwardArgs(h.sandboxId, port), { timeoutMs: QUICK_TIMEOUT_MS }),
    );
    return { url: `http://${fwd.host}:${fwd.port}` };
  },

  async refreshPreviewUrl(h, port: number): Promise<CloudPreviewUrl> {
    await runDevvm(forwardCloseArgs(h.sandboxId, port), { timeoutMs: QUICK_TIMEOUT_MS });
    return devvmBackend.previewUrl(h, port);
  },

  async createSnapshot(h, snapshotName: string) {
    await devvm(snapshotSaveArgs(h.sandboxId, snapshotName), { timeoutMs: START_TIMEOUT_MS });
  },
  async deleteSnapshot(snapshotName: string) {
    await devvm(snapshotRmArgs(snapshotName), { timeoutMs: QUICK_TIMEOUT_MS });
  },
  async snapshotExists(snapshotName: string) {
    const ids = parseSnapshots(await devvm(snapshotListArgs(), { timeoutMs: QUICK_TIMEOUT_MS }));
    return ids.includes(snapshotId(snapshotName));
  },
};

/** `find -printf '%y\t%f\n'` lines → entries (`d` is a folder). */
export function parseFindListing(out: string): CloudFileEntry[] {
  return out
    .split('\n')
    .filter((line) => line.includes('\t'))
    .map((line) => {
      const tab = line.indexOf('\t');
      return { name: line.slice(tab + 1), isDir: line.slice(0, tab) === 'd' };
    });
}

/** Whether the devvm on PATH (or `AGENTBOX_DEVVM_BIN`) is Stella's build with the headless verbs. */
export async function devvmVersion(): Promise<string | null> {
  try {
    const result = await runDevvm(['--version'], { timeoutMs: 15_000 });
    if (result.exitCode !== 0) return null;
    return result.stdout.trim().split(/\s+/).pop() ?? null;
  } catch {
    return null;
  }
}

export function isStellaBuild(version: string | null): boolean {
  return !!version && version.includes('-stella.');
}
