# Contributing

Contributions can improve plan-file editing, native approval, compatibility, tests, or documentation. Installation and everyday use are covered in the [English README](README.md) and [Chinese README](README.zh-CN.md).

## Report a problem

Include the DSH version, frontend and its version, operating system, steps to reproduce, and the expected and actual results. For an editing problem, provide a small Markdown example and the requested change. Keep private plan contents, personal paths, and model credentials out of public reports.

## Set up a development checkout

Fork the repository and create a branch for your change. Use Node.js 24.16.0 to match CI, then install the locked development dependencies from the repository root.

```bash
npm ci --ignore-scripts
```

This installs the development tools and private test workspace under `test/runtimes/`. The workspace pins the DSH and Cordis libraries used by the native tests. The plugin runtime requires Node.js 22 or later.

## Make and check a change

Keep the change focused. Format the files you edit with the repository's Prettier configuration. For example, after editing the English README, run the following command.

```bash
npx --no-install prettier --write README.md
```

For code changes, run the full check before opening a pull request.

```bash
npm run check
```

This checks formatting, JavaScript, and Markdown, runs the native regression suite, and verifies the packed plugin. CI runs the declared DSH test matrix on Linux, macOS, and Windows.

For documentation-only changes, format the affected Markdown files and run `npm run lint:markdown`.

| Command                  | What it checks                                                     |
| ------------------------ | ------------------------------------------------------------------ |
| `npm run format:check`   | Formatting against the repository's Prettier configuration         |
| `npm run lint`           | JavaScript and Markdown rules                                      |
| `npm test`               | Unit, native integration, compatibility, and release regressions   |
| `npm run test:native`    | Pinned DSH runtimes with zero skipped tests                        |
| `npm run verify:package` | Package contents and native editing and approval through its entry |

Native tests exercise DSH's compatibility gate, tool pipeline, filesystem, and PlanMode controller with scripted review answers. The runner checks package versions and shared Cordis identity before testing. Fixtures and verification output stay under `.agent-tmp/`.

To inspect the matrix or select a supported runtime, use the following commands.

```bash
node scripts/test-native.mjs --list
npm run test:native -- --version 0.2.2-rc.3
```

Set `DSH_NATIVE_PACKAGE` to an installed DSH `package.json` to check that installation against the same pinned versions.

Use synthetic plans in regression tests. Changes to editing and approval should preserve text outside exact replacements, reuse the session's file after resume and Plan Mode re-entry, and keep review content consistent with the saved file. Update both READMEs when installation or configuration changes.

## Maintain DSH compatibility

The current supported runtime is DSH `0.2.2-rc.3`. The private test workspaces, `engines.dsh`, and both README support tables must agree. Compatibility tests check that agreement and use DSH's own compatibility checker.

To add a supported DSH version, follow these steps.

1. Check the filesystem's versioned writes, tool guards and execution wrappers, PlanMode controller, and native review contracts against the existing implementation.
2. Add a private workspace under `test/runtimes/<DSH version>/package.json`. Pin the packages used by the existing workspace to exact matching DSH, Cordis, and Loader versions.
3. Update `engines.dsh` and both README support tables, then update the lockfile with `npm install --ignore-scripts`.
4. Run `npm run check`. CI derives its operating-system and DSH-version matrix from the workspaces automatically.

List tested DSH release candidates explicitly in the engine declaration. When changing the supported versions, update the workspaces, engine declaration, and support tables together.

## Validate in DSH Desktop

Keep DSH Desktop open, signed in, and idle, then run this from the checkout.

```bash
npm run test:desktop
```

The runner installs or refreshes the private `dsh-plan-files-dev` package with a `plan-files-dev` component and `[DEV]` titles. It connects a development controller through an owned block in the Desktop profile's `cordis.patch.yml`. Profile backups, candidate packages, synthetic projects, plans, and reports stay under `.agent-tmp/acceptance/`. Keep the checkout in place while using the controller.

Acceptance uses Desktop's configured real model and normal model quota. It checks plan creation, natural-language feedback, exact revision, native approval, and reuse of the file after Plan Mode re-entry with the standard and PTC presets. The runner checks for active conversations before switching this project's plugin.

Cleanup stops the owned test Agents, removes their saved conversations, restores the stable component states, and turns off the development bundle, component, and controller. Plan files and reports are retained for inspection. Cleanup failures fail the acceptance run.

The Desktop adapter has been exercised on macOS with DSH `0.2.2-rc.3`. macOS finds the bundled Desktop CLI automatically. Set `DSH_DESKTOP_CLI` to the bundled launcher if the installation is elsewhere.

For controller diagnostics, use the following commands after preparing a matching candidate with `npm run test:desktop`.

```bash
npm run acceptance -- connect
npm run acceptance -- status
npm run acceptance -- run
npm run acceptance -- off
```

Finish diagnostic sessions with `off`. Inspect the retained report before retrying an interrupted run.

## Validate dsh-TUI compatibility

With dsh-TUI installed and Python 3 available on macOS or Linux, run the terminal acceptance test.

```bash
npm run test:tui
```

The runner loads a development component through an isolated overlay and operates the real frontend in a pseudo-terminal. It exercises the `/plan` picker, Shift+Tab read-only mode, natural-language feedback, exact edits, and native approval. Model requests use the saved TUI model route or DSH's default and consume normal model quota.

Preferences, storage, session records, plans, and terminal output stay under a fresh `.agent-tmp/tui-*` directory. The runner removes its test conversations after exit, and the development component stops with the process. Reports and approved plans are retained.

Set `DSH_TUI_PACKAGE` to the frontend's `package.json` and `DSH_CLI` to the engine command when using other installation paths. For a configuration-only check, run `npm run test:tui:config`.

## Open a pull request

Target `main`. Describe the problem, the resulting behavior, and the checks you ran. Include reproduction steps for a bug fix and explain any compatibility limit the change introduces.

Write commit messages in English. Use `type(scope): short summary` for the subject and a bullet list for the body. For example, an approval fix could use this message.

```text
fix(plan-files): revalidate saved content before approval

- check the saved plan after the review answer returns
- cover external edits while Plan Review is open
```

Use the module as the scope when possible. Supported types are `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, and `revert`.

## Releases

Update the package version and lockfile, run `npm run check`, and commit the release changes. Push the matching version tag to trigger the Release workflow. It verifies the tagged commit, publishes the tested archive to npm through OIDC, and creates the GitHub Release. Stable versions use `latest`, and prerelease versions use `next`.

To preview a release, run **Release** in GitHub Actions with **dry_run** enabled. Leave **tag** empty to validate the selected branch, or supply an existing version tag. The workflow runs CI and executes `npm publish --dry-run` with the verified package.
