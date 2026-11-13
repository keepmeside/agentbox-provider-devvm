import { chmodSync, existsSync, mkdtempSync, mkdirSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { devvmBackend, makeVm } from '../src/backend.js';
import { runDevvm } from '../src/devvm.js';
import { prepareDevvm, RUNTIME_ASSETS } from '../src/prepare.js';

const MIB = 1024 * 1024;
let dir: string;
const saved = { bin: process.env['AGENTBOX_DEVVM_BIN'], home: process.env['HOME'] };

/** A fake devvm: the given shell `case` body runs on "$1". */
function fake(body: string): void {
  const bin = join(dir, 'devvm');
  writeFileSync(bin, `#!/bin/sh\ncase "$1" in\n${body}\nesac\nexit 9\n`);
  chmodSync(bin, 0o755);
  process.env['AGENTBOX_DEVVM_BIN'] = bin;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'devvm-backend-'));
  mkdirSync(join(dir, 'home'));
  process.env['HOME'] = join(dir, 'home');
});
afterEach(() => {
  for (const [key, value] of [['AGENTBOX_DEVVM_BIN', saved.bin], ['HOME', saved.home]] as const) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
});

describe('output limits', () => {
  it('a download streams every byte, past the text limit', async () => {
    fake(`  exec) head -c ${65 * MIB} /dev/zero; exit 0 ;;`);
    const out = join(dir, 'big.tar.gz');
    await devvmBackend.downloadFile({ sandboxId: 'vm1' }, '/workspace.tgz', out);
    expect(statSync(out).size).toBe(65 * MIB);
  });
  it('text output past the limit fails instead of coming back short', async () => {
    fake(`  exec) head -c ${65 * MIB} /dev/zero; exit 0 ;;`);
    const result = await runDevvm(['exec', '--vm', 'vm1', '--root', '--', 'cat', '/big']);
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toMatch(/more than 64 MiB/);
  });
  it('a failed download leaves no partial file', async () => {
    fake(`  exec) printf partial; echo gone >&2; exit 1 ;;`);
    const out = join(dir, 'f');
    await expect(devvmBackend.downloadFile({ sandboxId: 'vm1' }, '/x', out)).rejects.toThrow(/gone/);
    expect(existsSync(out)).toBe(false);
  });
});

describe('destroy', () => {
  it('fails when devvm cannot list its VMs, and never skips the delete silently', async () => {
    fake(`  ls) echo "devvm: lima_broken" >&2; exit 2 ;;\n  rm) touch "$HOME/rm-called"; exit 0 ;;`);
    await expect(devvmBackend.destroy({ sandboxId: 'devvm-ab-x-00000000000000' })).rejects.toThrow(/lima_broken/);
  });
  it('a VM devvm no longer lists is already gone', async () => {
    fake(`  ls) printf '{"version":1,"vms":[]}'; exit 0 ;;\n  rm) touch "$HOME/rm-called"; exit 0 ;;`);
    await devvmBackend.destroy({ sandboxId: 'devvm-ab-x-00000000000000' });
    expect(existsSync(join(dir, 'home', 'rm-called'))).toBe(false);
  });
});

describe('create', () => {
  it('a failed create removes its half-made VM and folder', async () => {
    const folder = join(dir, 'home', '.agentbox', 'devvm', 'ab-11111111');
    fake(
      `  ls) if [ -f "$HOME/made" ]; then printf '{"version":1,"vms":[{"name":"devvm-ab-11111111-0123456789abcd","status":"Broken","folder":"%s"}]}' "${folder}"; else printf '{"version":1,"vms":[]}'; fi; exit 0 ;;\n` +
        `  create) touch "$HOME/made"; echo "lima: boot failed" >&2; exit 1 ;;\n` +
        `  rm) rm -f "$HOME/made"; touch "$HOME/rm-called"; exit 0 ;;`,
    );
    await expect(makeVm(folder, { snapshot: 'ab-0123456789' })).rejects.toThrow(/boot failed/);
    expect(existsSync(join(dir, 'home', 'rm-called'))).toBe(true);
    expect(existsSync(folder)).toBe(false);
  });
  it('refuses to reuse a VM left in the box folder', async () => {
    const folder = join(dir, 'home', '.agentbox', 'devvm', 'ab-22222222');
    fake(
      `  ls) printf '{"version":1,"vms":[{"name":"devvm-ab-22222222-0123456789abcd","status":"Running","folder":"%s"}]}' "${folder}"; exit 0 ;;\n` +
        `  create) touch "$HOME/create-called"; exit 0 ;;`,
    );
    await expect(makeVm(folder, {})).rejects.toThrow(/left over/);
    expect(existsSync(join(dir, 'home', 'create-called'))).toBe(false);
  });
});

describe('prepare', () => {
  it('throws away a builder VM an interrupted bake left, then bakes', async () => {
    const runtime = join(dir, 'runtime');
    mkdirSync(join(runtime, '_shared'), { recursive: true });
    for (const asset of RUNTIME_ASSETS) {
      if ('shared' in asset.source) writeFileSync(join(runtime, '_shared', asset.source.shared), 'x');
    }
    const savedRuntime = process.env['AGENTBOX_CLI_RUNTIME_DIR'];
    process.env['AGENTBOX_CLI_RUNTIME_DIR'] = runtime;
    const builder = join(dir, 'home', '.agentbox', 'devvm', 'ab-prepare');
    fake(
      `  snapshot) printf '{"version":1,"snapshots":[]}'; exit 0 ;;\n` +
        `  ls) if [ -f "$HOME/rm-called" ]; then printf '{"version":1,"vms":[]}'; else printf '{"version":1,"vms":[{"name":"devvm-ab-prepare-0123456789abcd","status":"Running","folder":"%s"}]}' "${builder}"; fi; exit 0 ;;\n` +
        `  rm) touch "$HOME/rm-called"; exit 0 ;;\n` +
        `  create) touch "$HOME/create-called"; echo "stop here" >&2; exit 1 ;;`,
    );
    try {
      await expect(prepareDevvm({ onLog: () => {} })).rejects.toThrow(/stop here/);
    } finally {
      if (savedRuntime === undefined) delete process.env['AGENTBOX_CLI_RUNTIME_DIR'];
      else process.env['AGENTBOX_CLI_RUNTIME_DIR'] = savedRuntime;
    }
    expect(existsSync(join(dir, 'home', 'rm-called'))).toBe(true);
    // The builder's create ran (it was not refused as a leftover).
    expect(existsSync(join(dir, 'home', 'create-called'))).toBe(true);
  });
});
