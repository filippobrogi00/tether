# Security Policy

## Supported versions

Security fixes are applied to the latest release on the Visual Studio Marketplace / Open VSX and to the `main` branch of this repository.

## Reporting a vulnerability

Please **do not** open a public GitHub issue for security problems.

Email the maintainer with:

- A short description of the issue and its impact
- Steps to reproduce, or a proof of concept if you have one
- Affected versions if known

Prefer responsibly disclosed reports that involve authentication, host-key handling, credential storage, path traversal during sync, or unexpected code execution on either side of a sync.

You should receive an acknowledgement within a few days. Please give a reasonable window before any public disclosure.

## Scope notes

Tether is an SSH/SFTP client that copies files between your machine and servers you choose. Treat remote hosts as potentially untrusted content sources: keep [Workspace Trust](https://code.visualstudio.com/docs/editor/workspace-trust) enabled, and only sync with machines you trust.
