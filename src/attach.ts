/**
 * Attach to a devvm box: plain `ssh` over devvm's own ssh config (never the
 * user's ~/.ssh/config), with a TTY for an interactive attach, landing as the
 * box user `vscode` in AgentBox's shared tmux session.
 */

import {
  hostTermForCloud,
  renderInnerCommand,
  type AttachKind,
  type AttachSpec,
  type BoxRecord,
  type BuildAttachOptions,
} from '@madarco/agentbox-provider-sdk';
import { readSsh, type BoxSsh } from './backend.js';
import { shq } from './devvm.js';

export function attachArgv(ssh: BoxSsh, inner: string, interactive: boolean): string[] {
  return [
    'ssh',
    '-F',
    ssh.config,
    '-o',
    'BatchMode=yes',
    ...(interactive ? ['-tt'] : ['-T']),
    ssh.host,
    '--',
    `sudo -n -u vscode -H bash -lc ${shq(inner)}`,
  ];
}

export async function buildDevvmAttach(
  box: BoxRecord,
  kind: AttachKind,
  opts?: BuildAttachOptions,
): Promise<AttachSpec> {
  const vm = box.cloud?.sandboxId;
  if (!vm) throw new Error(`devvm box ${box.name} has no VM recorded.`);
  const ssh = await readSsh(vm);
  if (!ssh) throw new Error(`devvm box ${box.name}: its VM ${vm} has no ssh record. Destroy and create it again.`);
  const interactive = (kind === 'shell' || kind === 'agent') && !opts?.detached;
  const inner = `export LANG=C.UTF-8 LC_ALL=C.UTF-8 TERM=${hostTermForCloud()}; ${renderInnerCommand(kind, opts)}`;
  return { argv: attachArgv(ssh, inner, interactive) };
}
