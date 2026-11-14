# AGENTS.md

Guidance for AI coding agents working in this repository.

## Project overview

Tether is a VS Code extension that two-way syncs a local folder with a remote folder over SSH/SFTP. Nothing is installed on the server. Public product docs live in `README.md`; contributor setup is in `CONTRIBUTING.md`.

| Path | Role |
|---|---|
| `src/` | Extension host wiring (`vscode` imports OK) |
| `src/core/` | Sync engine — **no** `vscode` imports |
| `test/` | Unit / integration / smoke tests |
| `media/` | Walkthrough markdown shipped in the VSIX |
| `images/` | Marketplace icon + README banner / diagram |
| `dist/` | esbuild output (gitignored) |

## Reference documents

See `docs/ref/INDEX.md` for private datasheets and specs. Those files (except the index) are gitignored — do not commit them.

## Build and test

```bash
npm install
npm run build
npm test
npm run check
```

Press F5 for an Extension Development Host. Integration/smoke tests need `CL_TEST_TARGET=<ssh-host>`.

## Code style and conventions

- Prefer changes in `src/core/` when VS Code APIs are not required; cover them with tests.
- Keep user-facing copy in `README.md`, `CHANGELOG.md`, and `package.json` `contributes` in sync when behavior changes.
- Do not commit `*.vsix`, `dist/`, `node_modules/`, or secrets.

## Agent instructions

- Do not expand the public surface with agent-only tooling under paths users would confuse for product docs.
- Marketplace packaging is controlled by `.vscodeignore`: only `dist/extension.js`, `media/`, selected `images/`, and the manifesto files ship in the VSIX.
