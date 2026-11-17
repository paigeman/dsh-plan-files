# Contributing

## Set up a development checkout

Use Node.js 24. CI uses Node.js 24.16.0. Install the locked development dependencies from the repository root.

```bash
npm ci --ignore-scripts
```

Tool versions and rules follow `dsh-claude-memory`. Prettier formats supported files, ESLint checks JavaScript with its recommended rules and Node.js globals, and markdownlint checks Markdown.

## Make and check a change

Format the files you edit, then run the full check.

```bash
npm run format
npm run check
```

Individual checks are available while developing.

| Command                  | Purpose                                                             |
| ------------------------ | ------------------------------------------------------------------- |
| `npm run format`         | Format supported files                                              |
| `npm run format:check`   | Check formatting                                                    |
| `npm run lint:js`        | Check JavaScript and MJS files                                      |
| `npm run lint:markdown`  | Check Markdown                                                      |
| `npm run lint`           | Run all linters                                                     |
| `npm test`               | Run unit, compatibility, release, and native regression tests       |
| `npm run test:native`    | Run each pinned DSH runtime with zero skipped tests                 |
| `npm run verify:package` | Check the tarball and run native tests through its extracted entry  |
| `npm run check`          | Check formatting, lint, native compatibility, and the packed plugin |

To work on selected files, invoke the local tools directly.

```bash
npm exec --no -- prettier --write README.md
npm exec --no -- eslint eslint.config.mjs
npm exec --no -- markdownlint-cli2 README.md
```

Prettier uses two-space indentation, LF line endings, and a print width of 100. Markdown prose keeps its existing line wrapping. Markdown lint permits long lines and repeated headings under different parent sections, and uses fenced code blocks with backticks and asterisks for emphasis.

`node_modules/`, `.agent-tmp/`, and `coverage/` are excluded from Git, formatting, and lint checks. Keep agent-created temporary files under the repository's `.agent-tmp/` directory and track them according to the session's Agent Rules.

## Integration validation

Native integration tests use the exact DSH and Cordis versions declared in the private workspace under `test/runtimes/0.2.2-rc.3/`. The root `npm ci --ignore-scripts` installs these development dependencies.

```bash
npm run test:native
```

The runner checks the resolved package versions and shared Cordis identity, then exercises the native compatibility gate, tool pipeline, PlanMode controller, and local filesystem. It fails if any test is skipped. Fixtures stay under `.agent-tmp/`.

To select one declared runtime or inspect the matrix, use the following commands.

```bash
npm run test:native -- --version 0.2.2-rc.3
node scripts/test-native.mjs --list
```

For an explicitly selected external installation, set `DSH_NATIVE_PACKAGE` to its `@deepseek-ai/dsh/package.json`. Its packages must match the pinned test versions.

### Maintain DSH compatibility

The current support table contains DSH `0.2.2-rc.3`. `engines.dsh`, the runtime workspaces, and the tables in both READMEs describe the same supported versions. Compatibility regression tests enforce that agreement and use DSH's own loader check to validate the package declaration.

When adding a runtime, create a private workspace with exact DSH and Cordis versions. Update `engines.dsh` and both support tables together, install the test dependencies, then run `npm run check` to verify the native tools, compatibility declarations, and packed plugin. The CI matrix reads the workspace list automatically.

### Verify the package

```bash
npm run verify:package
```

This packs the formal `dsh-plan-files` package, checks its file allowlist and bundle identity, extracts it, and runs the native edit-and-approval suite through the extracted entry. The archive, `release.json`, and `SHA256SUMS` are retained under `.agent-tmp/package/`. Development scripts, test workspaces, and acceptance data stay outside the distributable. Local smoke fixtures are retained under `.agent-tmp/`.

### Desktop acceptance

Keep DSH Desktop open, signed in, and idle, then run the following command.

```bash
npm run test:desktop
```

The command builds and installs `dsh-plan-files-dev` with a `plan-files-dev` component and `[DEV]` titles. It reuses an installed candidate whose files still match the checkout. It adds an owned acceptance-controller block to the Desktop profile, with a backup under `.agent-tmp/acceptance/profile-backups/`. Test plans, package archives, and reports stay under `.agent-tmp/acceptance/`. The development package uses that isolated plan directory.

Acceptance activates the development component and creates an owned test Agent for each of the standard and PTC presets in a synthetic Git project. It sends a task to the configured real model and checks the saved plan, natural-language feedback, exact revision, native approval, and retained file. It then re-enters Plan Mode in the same session and verifies a further localized revision and approval of that file. This uses the model's normal quota. The controller checks for running conversations before switching this project's plugin. Cleanup restores the stable component states and turns off the development bundle, component, and acceptance controller.

Each test Agent has a recorded ID and lifecycle handle. Cleanup stops it, releases its writer, removes its JSONL record, and checks that it has disappeared from storage and the conversation list. Reports and test plan files remain available for inspection. The cleanup adapter targets the current DSH JSONL backend because this release has no public session-deletion API. It reports cleanup failures in the acceptance report.

The macOS runner locates the bundled Desktop CLI. Set `DSH_DESKTOP_CLI` for another installation. When the controller's source changes, its profile block uses a new entry identity and module URL so Desktop can load the revision through HMR. Reconnect the controller or inspect its current status with the following commands.

```bash
npm run acceptance -- connect
npm run acceptance -- status
```

To repeat acceptance with the matching installed candidate after connecting, run the following command.

```bash
npm run acceptance -- run
```

To close development components after a diagnostic connection, run the following command.

```bash
npm run acceptance -- off
```

### Third-party frontend compatibility

For a personal installation using dsh-TUI, run the following interactive integration test on macOS or Linux with Python 3 available.

```bash
npm run test:tui
```

The script first checks profile composition, then launches the installed engine and frontend in a pseudo-terminal. It operates the real `/plan` picker and Shift+Tab mode switch, types natural-language feedback into Plan Review, and approves the revised plan through the native panel. Both entries must reuse the session's file, preserve text outside each revision, exit Plan Mode after approval, and retain the Markdown file. Shift+Tab also exercises the read-only sandbox mode.

The development package is loaded through a temporary overlay. Session persistence, storage, plans, and TUI preferences live under a fresh `.agent-tmp/tui-*` directory. A process-local module hook redirects the frontend's data-directory constant to that test directory. The installed frontend files and profile configuration are read directly. A test observer records native events and delegates every approval answer to the TUI.

After the terminal exits, cleanup verifies session ownership and removes the test JSONL records. The temporary development component ends with its process. Reports, terminal output, and approved plans remain in the isolated run directory. The test reads the saved TUI model route and falls back to the native DSH default when that preference is absent. Requests use that model's normal quota.

Set `DSH_TUI_PACKAGE` to the frontend's `package.json` and `DSH_CLI` to the engine command when using other installation paths. To run only the boot-free configuration check, use the following command.

```bash
npm run test:tui:config
```

## CI

GitHub Actions runs on pushes to `main`, pull requests, and calls from the release workflow. The quality job checks formatting, JavaScript and Markdown lint, workflow syntax with actionlint, and the runtime matrix. Native jobs run the current DSH workspace on Linux, macOS, and Windows with zero skipped tests, then verify the packed plugin on each platform.

After the matrix passes, a package job creates the release archive and checksum metadata and uploads them as a workflow artifact. The release workflow checks out the planned commit and publishes that verified archive. Desktop and TUI acceptance use the configured real model and are run locally through their documented commands.

## Releases

The release workflow supports version tags such as `v0.1.0` and manual runs. Its tag must match `package.json`, and publication uses the commit resolved from that tag. Stable versions use npm's `latest` tag. Prerelease versions use `next`.

### Preview a release

In GitHub Actions, run **Release** with **dry_run** enabled. Leave **tag** empty to validate the selected branch, or supply an existing version tag. The workflow runs the full CI matrix, verifies the package artifact, and executes `npm publish --dry-run`.

The same package preview can be run locally after verification.

```bash
npm run verify:package
node scripts/release.mjs dry-run
```

### Configure npm publishing

Push the workflows to GitHub and let the three-platform CI finish. A push to `main` or a pull request runs CI. The release workflow also offers a manual dry run before a version tag is created.

npm requires the package to exist before a trusted publisher can be configured. For a new package, first publish the verified CI tarball using the package owner's npm account and two-factor authentication. Keep `NPM_PUBLISH_ENABLED` unset during this initial setup. The prerequisite is documented in [npm trust](https://docs.npmjs.com/cli/v11/commands/npm-trust/#prerequisites).

When preparing the next new package version, configure a trusted publisher for GitHub owner `paigeman`, repository `dsh-plan-files`, workflow filename `release.yml`, and environment `npm`. Permit direct `npm publish` for this connection. The workflow uses a GitHub-hosted runner with `id-token: write` and npm OIDC authentication. npm requires CLI 11.5.1 or later and Node.js 22.14.0 or later for this flow. The workflow pins Node.js 24.16.0. A new trusted publisher configuration must complete its first successful publication within two days. These settings follow the current [npm trusted publishing documentation](https://docs.npmjs.com/trusted-publishers/).

Create the GitHub environment `npm` and set repository variable `NPM_PUBLISH_ENABLED` to `true` when the package's publishing access is ready. GitHub Release creation also works while that variable is unset. It uploads the verified tarball and `SHA256SUMS` and reports the npm job's skipped state.

Push the next version tag to exercise OIDC publication. Re-running a version whose archive is already published takes the integrity-match skip path. An actual publication of a new version validates the OIDC connection.

### Publish a version

Update the package version and lockfile, run `npm run check`, and commit the release changes. Push the matching version tag to trigger the workflow. It reuses CI for that exact commit, publishes the tested archive, and creates the GitHub Release with generated notes.

A retry compares the existing npm version's integrity with the verified archive. Matching content completes that step without another publication. Conflicting content fails the run. Existing GitHub release notes are retained, and existing asset names must have matching bytes.
