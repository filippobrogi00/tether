# Contributing to Tether

Thanks for helping improve Tether. Small, focused pull requests are easiest to review.

## Development setup

Requirements: Node.js 20+ and npm.

```bash
npm install
npm run build          # bundle to dist/
npm test               # planner unit tests
npm run check          # TypeScript check
```

Press **F5** in VS Code or Cursor to launch an Extension Development Host with the extension loaded (see `.vscode/launch.json`).

### Integration and smoke tests

These need an SSH server you can reach with a key (localhost is fine):

```bash
CL_TEST_TARGET=myhost npm run test:integration
CL_TEST_TARGET=myhost npm run test:smoke
```

`docker/Dockerfile` builds a CentOS 7 OpenSSH image useful for regressing old-glibc hosts.

### Packaging

```bash
npm run package        # writes a .vsix (gitignored)
```

## Project layout

| Path | Purpose |
|---|---|
| `src/` | Extension entrypoints and VS Code wiring |
| `src/core/` | Sync engine with **no** `vscode` imports — keep it that way |
| `test/` | Unit, integration, and smoke tests |
| `media/` | Walkthrough markdown shipped inside the VSIX |
| `images/` | Marketplace icon and README visuals |
| `dist/` | Build output (gitignored; produced by esbuild) |

## Guidelines

- Match the existing TypeScript style and naming.
- Prefer changes in `src/core/` when the logic does not need the VS Code API, and cover them with tests.
- Do not commit `node_modules/`, `dist/`, `out-test/`, `*.vsix`, or `.DS_Store`.
- Do not commit private credentials, SSH keys, or datasheets under `docs/ref/` other than the public index.
- Update `CHANGELOG.md` for user-visible changes.

## Pull requests

1. Fork and branch from `main`.
2. Keep the diff focused on one concern.
3. Include or update tests when behavior changes.
4. Describe *why* the change is needed and how you verified it.

## Code of conduct

Be respectful in issues, discussions, and reviews. Harassment and personal attacks are not acceptable.
