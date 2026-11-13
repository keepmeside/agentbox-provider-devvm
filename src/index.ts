/**
 * agentbox-provider-devvm: an AgentBox provider that runs each box as a devvm
 * virtual machine on this computer, through Stella's devvm fork
 * (keepmeside/devvm). `createCloudProvider` supplies the box lifecycle
 * (workspace seeding, ctl launch, relay polling, checkpoints) over the thin
 * backend in backend.ts; `prepare` and `buildAttach` are this provider's own.
 */

import {
  createCloudProvider,
  errSummary,
  type CheckResult,
  type Provider,
  type ProviderDescriptor,
  type ProviderModule,
} from '@madarco/agentbox-provider-sdk';
import { BACKEND_NAME, devvmBackend, devvmVersion, isStellaBuild } from './backend.js';
import { buildDevvmAttach } from './attach.js';
import { currentFingerprint, prepareDevvm, readPrepared, requireBaseSnapshot } from './prepare.js';
import { devvmBin } from './devvm.js';

export const NOT_STELLA_DEVVM = "This devvm can't run boxes. Install Stella's devvm.";

const cloudProvider = createCloudProvider(devvmBackend, {
  defaultResources: { cpu: 2, memory: 4, disk: 100 },
  launchDockerd: false,
  // Every box starts from the base snapshot `prepare` baked.
  provisionImage: async () => requireBaseSnapshot(),
});

export const devvmProvider: Provider = {
  ...cloudProvider,
  prepare: prepareDevvm,
  buildAttach: buildDevvmAttach,
  baseFingerprint: () => currentFingerprint(),
};

export const devvmDescriptor: ProviderDescriptor = {
  name: BACKEND_NAME,
  kind: 'local',
  label: 'devvm (virtual machine on this computer)',
  loginHint: '',
  credentials: { envKeys: [], fields: [] },
  bake: { required: true, approxMinutes: '5-10' },
  capabilities: {
    checkpoints: true,
    // devvm saves a snapshot of a stopped VM: a checkpoint stops and starts the box.
    checkpointReboots: true,
    ssh: false,
    persistentSsh: false,
    directBoxSsh: false,
    inbound: false,
    directGit: false,
    resync: true,
    prune: true,
    vnc: false,
    dind: false,
    pauseSemantics: 'stop',
    hubRoutable: false,
  },
  blurb: 'a devvm virtual machine on this computer',
  sizeDesc: 'Per-provider override of `box.size` for devvm.',
  imageDesc: 'Per-provider override of `box.image` for devvm (a devvm snapshot ID).',
};

export async function doctorChecks(): Promise<CheckResult[]> {
  try {
    const version = await devvmVersion();
    const devvm: CheckResult = !version
      ? {
          label: 'devvm',
          status: 'fail',
          detail: `not found (${devvmBin()})`,
          hint: "Install Stella's devvm, or set AGENTBOX_DEVVM_BIN",
        }
      : isStellaBuild(version)
        ? { label: 'devvm', status: 'ok', detail: version }
        : { label: 'devvm', status: 'fail', detail: `${version}: ${NOT_STELLA_DEVVM}` };
    const base = readPrepared().base;
    const snapshot: CheckResult = base
      ? { label: 'base snapshot', status: 'ok', detail: base.snapshotId }
      : { label: 'base snapshot', status: 'warn', detail: 'not baked', hint: '`agentbox prepare --provider devvm`' };
    return [devvm, snapshot];
  } catch (err) {
    return [{ label: 'devvm', status: 'warn', detail: errSummary(err) }];
  }
}

export const providerModule: ProviderModule = {
  provider: devvmProvider,
  backend: devvmBackend,
  descriptor: devvmDescriptor,
  readCredStatus: () => ({ configured: true }),
  currentBaseFingerprintLive: () => currentFingerprint(),
  doctorChecks,
};

export { devvmBackend };
