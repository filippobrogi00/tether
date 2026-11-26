<p align="center">
  <img src="images/banner.png" alt="Tether — Lightweight SSH Sync" width="100%" />
</p>

# Tether — Lightweight SSH Sync

> **Modern local VS Code on legacy and shared servers.** Edit with your own extensions, toolchains, and Copilot/AI — sync over SSH, install nothing on the host.

[![Visual Studio Marketplace](https://vsmarketplacebadges.dev/version-short/filippobrogi00.tether-sync.svg)](https://marketplace.visualstudio.com/items?itemName=filippobrogi00.tether-sync)
[![Installs](https://vsmarketplacebadges.dev/installs-short/filippobrogi00.tether-sync.svg)](https://marketplace.visualstudio.com/items?itemName=filippobrogi00.tether-sync)
[![Rating](https://vsmarketplacebadges.dev/rating-short/filippobrogi00.tether-sync.svg)](https://marketplace.visualstudio.com/items?itemName=filippobrogi00.tether-sync&ssr=false#review-details)
[![Open VSX](https://img.shields.io/open-vsx/v/filippobrogi00/tether-sync?label=Open%20VSX)](https://open-vsx.org/extension/filippobrogi00/tether-sync)
[![License](https://img.shields.io/github/license/filippobrogi00/tether)](LICENSE)

**Tether** keeps your editor on your machine and syncs project files to any SSH server. Nothing is installed on the host — no VS Code Server, no agent, no daemon. Built for **legacy OS images** and **shared login nodes** where Remote - SSH cannot run or would crowd the machine.

<p align="center">
  <img src="images/how-it-works.png" alt="How Tether works: local VS Code with every extension, two-way SSH sync to a plain server folder" width="880" />
</p>

## Getting Started

Install from the [Visual Studio Marketplace](https://marketplace.visualstudio.com/items?itemName=filippobrogi00.tether-sync) or [Open VSX](https://open-vsx.org/extension/filippobrogi00/tether-sync):

```text
ext install filippobrogi00.tether-sync
```

1. Click **Tether** in the status bar, or run **Tether: Connect Folder…**.
2. Choose what to sync, then one server — or multiple servers (your local folder is the hub).
3. Pick the remote folder(s). Continuous two-way sync starts; no config file to write.

## Why Tether

| | Tether | Remote - SSH |
|---|---|---|
| **On the server** | Nothing | VS Code Server + workspace extensions |
| **Server load** | Brief listings + file transfers | Node IDE, language servers, watchers |
| **Requirements** | SSH + SFTP | Modern glibc / kernel ([details](https://code.visualstudio.com/docs/remote/linux)) |
| **Offline** | Keep editing; sync when back | Window waits on the link |
| **Editors** | VS Code and compatible forks | Microsoft VS Code |

Use Tether when you hit `GLIBC_2.28 not found`, quota-eating `~/.vscode-server`, or no Remote - SSH in your gallery. If you need the editor *on* the server (remote debug, huge repos), use Remote - SSH — they work side by side.

## Features

- **Two-way sync** — local changes push on edit; remote changes pull after terminal commands, on focus, and about once a minute.
- **Multi-server** — pair one local folder with several remotes. First connect resolves conflicts per server in order; later syncs run in parallel. More than two remotes can be slow.
- **Conflicts without silent overwrite** — keep local, keep that server’s copy, keep both, or merge text in the editor. Review labels name the server.
- **Connect picks** — choose top-level folders before the first sync; build/cache dirs and `.git` stay out by default.
- **Remote Terminal** — shell on the server (tmux/screen when available). With multiple remotes, pick which host; the panel is named after it.
- **Remote View, Upload / Download, Relay** — browse the remote tree, copy one-off paths, or move files between two remotes.
- **Port forwarding** — reach a server port at `localhost`.
- **Your SSH setup** — `~/.ssh/config`, keys, agent, passwords, 2FA, ProxyJump, host-key checks.
- **Offline-friendly** — edit while disconnected; changes sync when the link returns.

## Commands

All under **Tether** in the Command Palette; most also live in the status-bar menu.

| Command | What it does |
|---|---|
| **Connect Folder…** | Pair a local folder with one or more server folders and start sync. |
| **Remote Terminal** | Shell on a paired server (pick the host when several are connected). |
| **Toggle Remote View** | Show or hide a second Explorer root over the remote folder. Hiding restores your original single-folder workspace. |
| **Upload… / Download…** | One-shot copy of chosen paths. |
| **Relay…** | Copy or move between two remote locations. |
| **Toggle Sync / Reconnect / Disconnect** | Pause, resume, or tear down the session. |

## Settings

Works with defaults. Useful knobs: `tether.ignore`, `tether.respectGitignore`, `tether.maxFileSizeMB`, `tether.pollIntervalSeconds`, `tether.conflictPolicy`, `tether.confirmDeletesOver`, `tether.concurrency`, `tether.compressTransfers`, `tether.autoConnect`.

## Requirements

- **Local:** VS Code 1.85+ (or a compatible editor), Windows / macOS / Linux.
- **Server:** Linux or Unix with SSH + SFTP. No root, no install, no extra ports. Windows servers are not supported.

## Security

Sync only with servers you trust and keep Workspace Trust on. Host keys are verified; passwords are stored only if you choose Remember (system keychain). See [SECURITY.md](SECURITY.md).

## Known Limitations

Extensions see **local** files, not the server’s toolchain. Symlinks and empty folders are not synced. Very large, frequently changing files are a poor fit (100 MB skip by default). `ProxyCommand` is not supported yet (`ProxyJump` is).

## Troubleshooting

**Tether: Show Log** records connections and transfers. Common fixes: confirm `ssh user@host` works; for a changed host key use `ssh-keygen -R <host>` only if expected; check ignore settings if a file never syncs; use conflict review when the status bar says “to review”.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). Release notes: [CHANGELOG.md](CHANGELOG.md).

```bash
npm install && npm run build && npm test
```

## License

[MIT](LICENSE). Independent project — not affiliated with Microsoft.
