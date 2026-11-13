import { chmodSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  boxFolder,
  boxShell,
  cloudState,
  createArgs,
  execArgs,
  forwardArgs,
  memoryGib,
  parseCreate,
  parseForward,
  parseLs,
  parseSnapshots,
  rmArgs,
  snapshotId,
  snapshotRmArgs,
  snapshotSaveArgs,
  startArgs,
  stopArgs,
} from '../src/devvm.js';
import { devvmBackend, parseFindListing } from '../src/backend.js';
import { attachArgv } from '../src/attach.js';
import { baseSnapshotId } from '../src/prepare.js';

// `devvm create --json` as the fork prints it (testdata/script/stella.txtar, 0.1.1-stella.2).
const CREATE_SAMPLE = `{
  "version": 1,
  "vm": {
    "name": "devvm-ab-1a2b3c4d-0123456789abcd",
    "folder": "/Users/u/.agentbox/devvm/ab-1a2b3c4d",
    "status": "Running",
    "ssh": {
      "config": "/Users/u/.local/share/devvm/ssh_config",
      "host": "devvm-ab-1a2b3c4d"
    }
  }
}`;

const LS_SAMPLE = `{
  "version": 1,
  "vms": [
    { "name": "devvm-ab-1a2b3c4d-0123456789abcd", "status": "Running", "folder": "/Users/u/.agentbox/devvm/ab-1a2b3c4d" },
    { "name": "devvm-ab-prepare-11111111111111", "status": "Stopped", "folder": "/Users/u/.agentbox/devvm/ab-prepare" },
    { "name": "devvm-web-91e3e4ca0febc0", "status": "Running", "folder": "/Users/u/code/web" },
    { "name": "devvm-x-22222222222222", "status": "Running", "folder": "/Users/u/.agentbox/devvm-old/x" }
  ]
}`;

describe('argv builders', () => {
  it('create is headless, internet tier, no ports, whole GiB, from a snapshot', () => {
    expect(createArgs({ cpu: 2, memory: 4, snapshot: 'ab-0123456789' })).toEqual([
      'create', '--json', '--no-input', '--tools', 'none', '--agents', 'none', '--layers', 'none',
      '--network', 'internet', '--ports', 'none', '--cpus', '2', '--memory', '4',
      '--from-snapshot', 'ab-0123456789',
    ]);
    expect(createArgs({ cpu: 0.4, memory: 2.5 })).toContain('3');
    expect(createArgs({})).not.toContain('--from-snapshot');
  });
  it('memory rounds up and never goes below 1', () => {
    expect([0.5, 1, 2.1, 8].map(memoryGib)).toEqual([1, 1, 3, 8]);
    expect(memoryGib(undefined)).toBe(4);
  });
  it('every verb names the VM', () => {
    expect(execArgs('vm1', ['cat', '/x'])).toEqual(['exec', '--vm', 'vm1', '--root', '--', 'cat', '/x']);
    expect(execArgs('vm1', ['sh'], true)).toEqual(['exec', '--vm', 'vm1', '-i', '--root', '--', 'sh']);
    expect(startArgs('vm1')).toEqual(['start', '--no-input', '--vm', 'vm1']);
    expect(stopArgs('vm1')).toEqual(['stop', '--no-input', '--vm', 'vm1']);
    expect(rmArgs('vm1')).toEqual(['rm', '--no-input', '--vm', 'vm1', '--force', '--no-export', '--no-clone-check']);
    expect(forwardArgs('vm1', 8788)).toEqual(['forward', '--vm', 'vm1', '--json', '8788']);
    expect(snapshotSaveArgs('vm1', 'cp-one')).toEqual(['snapshot', 'save', '--no-input', '--vm', 'vm1', 'cp-one']);
    expect(snapshotRmArgs('cp-one')).toEqual(['snapshot', 'rm', '--no-input', 'cp-one']);
  });
});

describe('snapshot IDs', () => {
  it('keeps a valid ID and maps every other name to a valid, distinct one', () => {
    expect(snapshotId('ab-0123456789')).toBe('ab-0123456789');
    // A valid devvm ID too long for Lima's socket path is shortened.
    expect(snapshotId('agentbox-base-0123456789ab')).toMatch(/^s-[0-9a-f]{10}$/);
    const ids = ['My Checkpoint', 'my_checkpoint', 'my-checkpoint-0123456789abcd', 'x'.repeat(60), '__'].map(snapshotId);
    for (const id of ids) {
      expect(id).toMatch(/^[a-z0-9][a-z0-9-]{0,12}$/);
      expect(id).not.toMatch(/-[0-9a-f]{14}$/);
    }
    expect(new Set(ids).size).toBe(ids.length);
    // Stable: a mapped ID maps to itself, so a stored ID reaches the same snapshot.
    for (const id of ids) expect(snapshotId(id)).toBe(id);
  });
  it('the snapshot instance name fits Lima\'s socket path on a 28-character home', () => {
    const socket = (id: string) =>
      `/Users/abcdefghijklmnopqrstu/.local/share/devvm/lima/devvm-snap-${id}/ssh.sock.1234567890123456`;
    for (const name of ['My Checkpoint', 'x'.repeat(60), 'agentbox-base-0123456789ab']) {
      expect(socket(snapshotId(name)).length).toBeLessThan(104);
    }
    expect(socket(baseSnapshotId('ab'.repeat(32))).length).toBeLessThan(104);
  });
  it('the base snapshot ID is valid', () => {
    expect(snapshotId(baseSnapshotId('ab'.repeat(32)))).toBe(baseSnapshotId('ab'.repeat(32)));
  });
});

describe('box folders', () => {
  it('are short, fixed width and distinct per box name', () => {
    const a = boxFolder('stella-app-1a2b', '/Users/u');
    const b = boxFolder('stella-app-1a2c', '/Users/u');
    expect(a).toMatch(/^\/Users\/u\/\.agentbox\/devvm\/ab-[0-9a-f]{8}$/);
    expect(a).not.toBe(b);
  });
});

describe('parsers', () => {
  it('create gives the VM and its ssh alias', () => {
    expect(parseCreate(CREATE_SAMPLE)).toEqual({
      name: 'devvm-ab-1a2b3c4d-0123456789abcd',
      status: 'Running',
      folder: '/Users/u/.agentbox/devvm/ab-1a2b3c4d',
      ssh: { config: '/Users/u/.local/share/devvm/ssh_config', host: 'devvm-ab-1a2b3c4d' },
    });
    expect(() => parseCreate('{"version":1}')).toThrow(/Stella's devvm/);
    expect(() => parseCreate('not json')).toThrow(/unexpected/);
  });
  it('ls keeps only VMs inside the boxes folder (not a sibling with the same prefix)', () => {
    const vms = parseLs(LS_SAMPLE, '/Users/u/.agentbox/devvm');
    expect(vms.map((vm) => vm.name)).toEqual([
      'devvm-ab-1a2b3c4d-0123456789abcd',
      'devvm-ab-prepare-11111111111111',
    ]);
  });
  it('forward and snapshot listings', () => {
    expect(parseForward('{\n  "host": "127.0.0.1",\n  "port": 62551\n}')).toEqual({ host: '127.0.0.1', port: 62551 });
    expect(() => parseForward('{}')).toThrow(/no port/);
    expect(parseSnapshots('{"snapshots":[{"id":"stella-s1"},{"id":"agentbox-base-1"}]}')).toEqual(['stella-s1', 'agentbox-base-1']);
    expect(parseSnapshots('{"snapshots":[]}')).toEqual([]);
  });
  it('states', () => {
    expect(['Running', 'Stopped', 'Broken', ''].map(cloudState)).toEqual(['running', 'stopped', 'stopped', 'missing']);
  });
  it('find listing', () => {
    expect(parseFindListing('d\tsrc\nf\tREADME.md\nf\ta\tb\n')).toEqual([
      { name: 'src', isDir: true },
      { name: 'README.md', isDir: false },
      { name: 'a\tb', isDir: false },
    ]);
  });
});

describe('exec and attach shells', () => {
  it('drops to vscode by default, keeps root when asked, quotes env and cwd', () => {
    expect(boxShell('ls', { cwd: "/w s", env: { A: "x'y", 'bad key': 'z' } })).toEqual([
      'sudo', '-n', '-u', 'vscode', '-H', 'bash', '-lc', `export A='x'\\''y'; cd '/w s' && ls`,
    ]);
    expect(boxShell('id', { user: 'root' })).toEqual(['bash', '-lc', 'id']);
  });
  it('attach is ssh over devvm\'s own config, a TTY only when interactive', () => {
    const ssh = { config: '/c/ssh_config', host: 'devvm-ab-1' };
    expect(attachArgv(ssh, "tmux a -t 'x'", true)).toEqual([
      'ssh', '-F', '/c/ssh_config', '-o', 'BatchMode=yes', '-tt', 'devvm-ab-1', '--',
      `sudo -n -u vscode -H bash -lc 'tmux a -t '\\''x'\\'''`,
    ]);
    expect(attachArgv(ssh, 'true', false)).toContain('-T');
  });
});

describe('previewUrl', () => {
  const saved = process.env['AGENTBOX_DEVVM_BIN'];
  afterEach(() => {
    if (saved === undefined) delete process.env['AGENTBOX_DEVVM_BIN'];
    else process.env['AGENTBOX_DEVVM_BIN'] = saved;
  });
  it('is the forwarded host port, not the guest port', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'devvm-fake-'));
    const fake = join(dir, 'devvm');
    writeFileSync(
      fake,
      `#!/bin/sh\n[ "$1" = forward ] && [ "$3" = vm9 ] && [ "$5" = 8788 ] && printf '{"host":"127.0.0.1","port":47001}\\n' && exit 0\nexit 3\n`,
    );
    chmodSync(fake, 0o755);
    process.env['AGENTBOX_DEVVM_BIN'] = fake;
    const url = await devvmBackend.previewUrl({ sandboxId: 'vm9' }, 8788);
    expect(url).toEqual({ url: 'http://127.0.0.1:47001' });
    await expect(devvmBackend.previewUrl({ sandboxId: 'other' }, 8788)).rejects.toThrow(/exit 3/);
  });
});
