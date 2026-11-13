/**
 * The devvm command lines this provider runs, their JSON answers, and the one
 * process wrapper every call goes through. Needs Stella's devvm fork
 * (keepmeside/devvm, 0.1.1-stella.2 or newer): its headless verbs (`create`,
 * `start`, `exec`, `forward`, `snapshot`) are what make a VM usable as a box.
 */

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** The devvm executable: `AGENTBOX_DEVVM_BIN` (Stella sets it), else `devvm` on PATH. */
export function devvmBin(env: NodeJS.ProcessEnv = process.env): string {
  const bin = env['AGENTBOX_DEVVM_BIN'];
  return bin && bin.length > 0 ? bin : 'devvm';
}

/** Where each box's (empty) folder lives: devvm makes the VM of a folder. */
export function boxesRoot(home: string = homedir()): string {
  return join(home, '.agentbox', 'devvm');
}

/**
 * A box's folder. Its name is short and fixed-width (`ab-<8 hex>`) because
 * devvm names the VM after it and Lima's ssh socket path must stay under 104
 * characters; it is unique per box name, so each VM has its own ssh alias.
 */
export function boxFolder(boxName: string, home: string = homedir()): string {
  const digest = createHash('sha256').update(boxName).digest('hex').slice(0, 8);
  return join(boxesRoot(home), `ab-${digest}`);
}

/** The builder VM `prepare` bakes the base in. */
export function builderFolder(home: string = homedir()): string {
  return join(boxesRoot(home), 'ab-prepare');
}

/**
 * devvm's snapshot ID rule is `[a-z0-9][a-z0-9-]{0,39}`, but Lima names the
 * snapshot's instance `devvm-snap-<ID>` and refuses one whose ssh socket path
 * (`<home>/.local/share/devvm/lima/devvm-snap-<ID>/ssh.sock.<16>`) reaches 104
 * characters. IDs here stay at 13 characters, so a snapshot fits on any home
 * folder path a box VM fits on (28 characters).
 */
const SNAPSHOT_ID = /^[a-z0-9][a-z0-9-]{0,12}$/;
/** A name devvm would read as a project VM's (`…-<14 hex>`), which it refuses as a snapshot ID. */
const VM_SHAPED = /-[0-9a-f]{14}$/;

/**
 * The devvm snapshot ID for an agentbox snapshot name. A short valid ID is
 * kept as it is (so a stored ID maps to itself); any other name becomes
 * `s-<10 hex>` of its SHA-256, so two names never share an ID.
 */
export function snapshotId(name: string): string {
  if (SNAPSHOT_ID.test(name) && !VM_SHAPED.test(name)) return name;
  return `s-${createHash('sha256').update(name).digest('hex').slice(0, 10)}`;
}

/** Whole GiB, rounded up, at least 1. */
export function memoryGib(memory: number | undefined): number {
  return Math.max(1, Math.ceil(memory ?? 4));
}

export function createArgs(opts: { cpu?: number; memory?: number; snapshot?: string }): string[] {
  const out = [
    'create',
    '--json',
    '--no-input',
    '--tools',
    'none',
    '--agents',
    'none',
    '--layers',
    'none',
    '--network',
    'internet',
    '--ports',
    'none',
    '--cpus',
    String(Math.max(1, Math.round(opts.cpu ?? 2))),
    '--memory',
    String(memoryGib(opts.memory)),
  ];
  if (opts.snapshot) out.push('--from-snapshot', snapshotId(opts.snapshot));
  return out;
}

/** Runs `argv` as root in the VM (`devvm exec --root`); `-i` passes stdin. */
export function execArgs(vm: string, argv: string[], stdin = false): string[] {
  return ['exec', '--vm', vm, ...(stdin ? ['-i'] : []), '--root', '--', ...argv];
}

export const startArgs = (vm: string): string[] => ['start', '--no-input', '--vm', vm];
export const stopArgs = (vm: string): string[] => ['stop', '--no-input', '--vm', vm];
/** Deletes the VM only, never its folder. */
export const rmArgs = (vm: string): string[] => [
  'rm',
  '--no-input',
  '--vm',
  vm,
  '--force',
  '--no-export',
  '--no-clone-check',
];
export const lsArgs = (): string[] => ['ls', '--json'];
export const forwardArgs = (vm: string, port: number): string[] => [
  'forward',
  '--vm',
  vm,
  '--json',
  String(port),
];
export const forwardCloseArgs = (vm: string, port: number): string[] => [
  'forward',
  '--vm',
  vm,
  '--close',
  String(port),
];
export const snapshotSaveArgs = (vm: string, name: string): string[] => [
  'snapshot',
  'save',
  '--no-input',
  '--vm',
  vm,
  snapshotId(name),
];
export const snapshotRmArgs = (name: string): string[] => [
  'snapshot',
  'rm',
  '--no-input',
  snapshotId(name),
];
export const snapshotListArgs = (): string[] => ['snapshot', '--json'];

export interface DevvmVm {
  name: string;
  status: string;
  folder: string;
}

export interface CreatedVm extends DevvmVm {
  ssh: { config: string; host: string };
}

function parse<T>(json: string, verb: string): T {
  try {
    return JSON.parse(json.trim()) as T;
  } catch (err) {
    throw new Error(`devvm ${verb} printed something unexpected: ${(err as Error).message}`);
  }
}

/** `devvm ls --json`: only the VMs whose folder is inside `root` are this provider's. */
export function parseLs(json: string, root: string): DevvmVm[] {
  const listing = parse<{ vms?: Partial<DevvmVm>[] }>(json, 'ls');
  const prefix = root.endsWith('/') ? root : `${root}/`;
  return (listing.vms ?? [])
    .filter((vm): vm is DevvmVm => typeof vm.name === 'string')
    .map((vm) => ({ name: vm.name, status: vm.status ?? '', folder: vm.folder ?? '' }))
    .filter((vm) => vm.folder.startsWith(prefix));
}

export function parseCreate(json: string): CreatedVm {
  const created = parse<{ vm?: Partial<CreatedVm> }>(json, 'create');
  const vm = created.vm;
  if (!vm?.name || !vm.ssh?.config || !vm.ssh.host) {
    throw new Error('devvm create printed no VM. Is this Stella\'s devvm (keepmeside/devvm)?');
  }
  return { name: vm.name, status: vm.status ?? '', folder: vm.folder ?? '', ssh: vm.ssh };
}

/** `devvm forward --json`: the loopback port this computer forwards to the guest port. */
export function parseForward(json: string): { host: string; port: number } {
  const fwd = parse<{ host?: string; port?: number }>(json, 'forward');
  if (typeof fwd.port !== 'number') throw new Error('devvm forward printed no port.');
  return { host: fwd.host ?? '127.0.0.1', port: fwd.port };
}

export function parseSnapshots(json: string): string[] {
  const list = parse<{ snapshots?: { id?: string }[] }>(json, 'snapshot');
  return (list.snapshots ?? []).map((s) => s.id).filter((id): id is string => !!id);
}

/** agentbox's state word for devvm's status. */
export function cloudState(status: string): 'running' | 'stopped' | 'missing' {
  if (status === 'Running') return 'running';
  if (status === '' || status === 'Missing') return 'missing';
  return 'stopped';
}

/** `'…'` for a POSIX shell. */
export function shq(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell text `exec` runs as root: drop to `user` (unless root), set the
 * env, enter `cwd`, then run `cmd` in a login bash.
 */
export function boxShell(
  cmd: string,
  opts: { user?: string; cwd?: string; env?: Record<string, string> } = {},
): string[] {
  const env = Object.entries(opts.env ?? {})
    .filter(([key]) => /^[A-Za-z_][A-Za-z0-9_]*$/.test(key))
    .map(([key, value]) => `export ${key}=${shq(value)}; `)
    .join('');
  const inner = `${env}${opts.cwd ? `cd ${shq(opts.cwd)} && ` : ''}${cmd}`;
  const user = opts.user ?? 'vscode';
  if (user === 'root') return ['bash', '-lc', inner];
  return ['sudo', '-n', '-u', user, '-H', 'bash', '-lc', inner];
}

export interface RunResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

export interface RunOptions {
  cwd?: string;
  input?: Buffer | string;
  timeoutMs?: number;
  /** Raw stdout bytes instead of text (downloads). */
  binary?: boolean;
  onLine?: (line: string) => void;
}

const OUTPUT_LIMIT = 64 * 1024 * 1024;

/** Runs devvm and waits at most `timeoutMs` (default 120 s). Never throws for a non-zero exit. */
export function runDevvm(
  args: string[],
  opts: RunOptions = {},
): Promise<RunResult & { raw: Buffer }> {
  return new Promise((resolve, reject) => {
    const child = spawn(devvmBin(), args, {
      cwd: opts.cwd,
      stdio: [opts.input === undefined ? 'ignore' : 'pipe', 'pipe', 'pipe'],
      env: process.env,
    });
    const out: Buffer[] = [];
    let outLen = 0;
    let err = '';
    let partial = '';
    child.stdout?.on('data', (chunk: Buffer) => {
      if (outLen < OUTPUT_LIMIT) {
        out.push(chunk);
        outLen += chunk.length;
      }
      if (opts.onLine) {
        partial += chunk.toString('utf8');
        let nl: number;
        while ((nl = partial.indexOf('\n')) !== -1) {
          opts.onLine(partial.slice(0, nl));
          partial = partial.slice(nl + 1);
        }
      }
    });
    child.stderr?.on('data', (chunk: Buffer) => {
      if (err.length < 1024 * 1024) err += chunk.toString('utf8');
      if (opts.onLine) for (const line of chunk.toString('utf8').split('\n')) if (line) opts.onLine(line);
    });
    const timeoutMs = opts.timeoutMs ?? 120_000;
    const timer = setTimeout(() => {
      child.kill('SIGTERM');
      setTimeout(() => child.kill('SIGKILL'), 2000).unref();
      err += `\ndevvm ${args[0] ?? ''} took longer than ${Math.round(timeoutMs / 1000)} seconds.`;
    }, timeoutMs);
    child.on('error', (e) => {
      clearTimeout(timer);
      reject(
        (e as NodeJS.ErrnoException).code === 'ENOENT'
          ? new Error("devvm isn't installed. Install Stella's devvm, or set AGENTBOX_DEVVM_BIN.")
          : e,
      );
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (opts.onLine && partial) opts.onLine(partial);
      const raw = Buffer.concat(out);
      resolve({
        exitCode: code ?? 1,
        stdout: opts.binary ? '' : raw.toString('utf8'),
        stderr: err,
        raw,
      });
    });
    if (opts.input !== undefined && child.stdin) {
      child.stdin.on('error', () => {});
      child.stdin.end(opts.input);
    }
  });
}

/** Like `runDevvm`, but a non-zero exit is an error carrying devvm's own last words. */
export async function devvm(args: string[], opts: RunOptions = {}): Promise<string> {
  const result = await runDevvm(args, opts);
  if (result.exitCode !== 0) {
    const detail = (result.stderr.trim() || result.stdout.trim()).split('\n').slice(-5).join('\n');
    throw new Error(`devvm ${args.slice(0, 2).join(' ')} failed (exit ${result.exitCode}): ${detail}`);
  }
  return result.stdout;
}
