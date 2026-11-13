# agentbox-provider-devvm

An [AgentBox](https://github.com/madarco/agentbox) provider that runs each box
as a [devvm](https://github.com/devvmhq/devvm) virtual machine on this computer.
It needs Stella's devvm build ([keepmeside/devvm](https://github.com/keepmeside/devvm),
`0.1.1-stella.2` or newer), whose headless verbs (`create`, `start`, `exec`,
`forward`, `snapshot`) make a VM usable as a box. A stock devvm fails
`agentbox doctor` with "This devvm can't run boxes. Install Stella's devvm."

## Install

```bash
npm install && npm run build
agentbox plugin add /path/to/agentbox-provider-devvm --yes
agentbox doctor                          # a `devvm:` group
agentbox prepare --provider devvm        # bake the base snapshot (one time, a few minutes)
agentbox devvm claude --inline -y -n my-box
```

Stella installs it for you from this repository's release tarball and sets
`AGENTBOX_DEVVM_BIN` to its own devvm. Run by hand, the provider uses
`AGENTBOX_DEVVM_BIN` when set, else `devvm` on `PATH`.

## How a box maps onto devvm

- Each box is the VM of an empty folder `~/.agentbox/devvm/ab-<8 hex>`; `destroy`
  deletes the VM and the folder.
- `prepare` makes a builder VM, runs `scripts/install-box.sh` as root with
  AgentBox's box runtime, and saves it as the devvm snapshot
  `agentbox-base-<12 hex>`; every box starts from it.
- Preview URLs are `devvm forward` loopback ports (one per box and port).
- Checkpoints are devvm snapshots. Saving one stops and starts the box.
- No Docker-in-Docker and no VNC in a box.

MIT licensed. `scripts/install-box.sh` and `scripts/custom-system-CLAUDE.md` are
adapted from AgentBox's Hetzner installer (MIT).
