# Changelog

## Unreleased

## 0.5.0 — 2026-11-26

- First sync with many one-sided files streams one gzip archive over the open SSH channel (pack and extract overlap; no temp `.tgz` on either side). Local listing walks directories in parallel; remote listing falls back through GNU find, GNU `stat`, and BSD `stat` in one round trip. After the archive lands, only the destination is rescanned.
- **Connect Folder…** reconnects immediately when the local folder already has a saved pairing (same hosts and mount points). Use **Pair with Different Servers…** to replace the pairing.
- **Change Folder…** points one connected server at a different remote folder, then syncs with the usual conflict handling. By default the old remote folder is deleted after confirm (`tether.cleanupOldRemoteOnChangeFolder`).
- **Add Remote Server…** pairs another server with a folder that is already connected. If both sides have files, Tether asks to merge, then resolves that server's conflicts before it joins the others.
- **Remote View** asks which server when several are paired. Servers that already have a Remote View root are listed as already open (not opened again); Close removes that root. Each server keeps an active/inactive flag.

## 0.4.1 — 2026-11-26

- **Toggle Remote View** opens and closes the remote Explorer root. Closing restores the original single-folder workspace (no leftover Untitled / named multi-root).

## 0.4.0 — 2026-11-25

- **Connect Folder…** can pair one local folder with multiple remote servers. Local is the hub: the first connect resolves conflicts with each server in order; reconnect and ongoing sync run in parallel. A warning appears before adding a third (or further) remote.
- Conflict review and the status bar name the server you are deciding against.
- **Remote Terminal** (and port forward) asks which server when several are paired, remembers the last choice, and names the panel after that host (`host`, then `host #2`, …).
- README trimmed to a features-first overview.

## 0.3.0 — 2026-11-24

- Build and cache directories are not synced. The default ignore list covers dependency folders, virtual environments, and compiler output used across languages (`build/`, `target/`, `dist/`, `out/`, `obj/`, and tool caches such as `.next/` and `.gradle/`). If `tether.ignore` is already set in your settings, reset it to pick up the new default.
- **Connect Folder…** lists the top-level files and folders with checkboxes before it connects. Build output, caches, and `.git` start unchecked. Uncheck anything else that should stay on this computer, or check a folder back on when it should be synced. The choice is saved with the pairing.
- A git fetch no longer pins the status bar. `FETCH_HEAD`, lock files, and other git scratch files are never synced, and a file that changes while it is uploading cannot stall the transfer.
- `.git/` is never copied. After the files arrive, the server folder is initialized with `git init`, the local `origin` URL, and the same upstream branch.
- The remote terminal uses its own SSH connection and reattaches to tmux or screen when that connection stalls, so the panel does not stay open and ignore keystrokes.
- The first sync packs only the files that are meant to be copied, so an ignored folder such as `.git/` is not included in the archive.
- The status bar keeps showing the sync that is actually running when another file changes behind it.
- Conflict review opens a menu first: keep all/some local copies, keep all/some remote copies, or review each file manually.
- Relay… uses Explorer selection (paired local folder or Remote View) as the transfer source when items are already selected; otherwise opens the remote selection basket as before.

## 0.2.0 — 2026-11-16

- Upload… / Download… one-shot copy of chosen files or folders to/from the server (multi-select), with a remote selection basket for downloads.
- Relay… copy or move files and folders between two remote locations.

## 0.1.0

- Two-way sync between a local folder and a folder on any SSH server, with nothing installed on the server.
- Connect wizard: hosts from `~/.ssh/config`, click-through remote folder browser.
- Local changes pushed on save or on any file change; remote changes pulled periodically, on window focus, and after terminal commands.
- Conflict detection with compare / keep mine / keep server / keep both.
- Terminal on the server, port forwarding, automatic reconnect, offline editing.
- Upload… / Download… one-shot copy of a chosen file or folder to/from the server.
- Keys, ssh-agent, passphrases, passwords, keyboard-interactive (2FA), ProxyJump, host key verification.
