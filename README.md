# Plan Files for DeepSeek Harness

[中文说明](README.zh-CN.md)

DSH Plan Files keeps DeepSeek Harness (DSH) plans in independent Markdown files while using DSH's native Plan Review for feedback and approval.

The plugin supports DSH `0.2.2-rc.3` and Node.js 22 or later.

## Installation

### Local source

Clone this repository and install its root directory into the DSH profile you use. This example uses the native `tui` profile.

```bash
git clone https://github.com/paigeman/dsh-plan-files.git
cd dsh-plan-files
dsh plugin --profile tui add "link:$PWD"
dsh --profile tui --dump-config
```

Check for component ID `plan-files` and package name `dsh-plan-files` in the configuration. Keep the source directory after installing a local link.

In DSH Desktop, open **Plugins**, choose **Add plugin**, select a local directory, and enter the repository's absolute path. Enable the bundle and its **Plan Files** component.

### npm package

Install the published package into your profile.

```bash
dsh plugin --profile tui add dsh-plan-files
```

In Desktop's plugin manager, choose the npm registry source and enter `dsh-plan-files`.

## Workflow

```text
/plan
  → Create and save a Markdown plan
  → Open native Plan Review
  → Receive natural-language feedback
  → Apply localized edits to the same file
  → Open native Plan Review again
  → Approve, exit Plan Mode, and keep the file
```

Give feedback in ordinary language. The Agent locates the relevant passages and applies exact replacements or localized patches to the same file. Text outside a patch is preserved verbatim. Ambiguous feedback or a significantly broader change calls for clarification.

The plugin retains the native `/plan`, `exit_plan_mode`, **Approve**, **Keep planning**, and feedback flow.

## Plan files

Plans live in `~/.dsh/plans/`, with names following this pattern. A configured `DSH_HOME` changes the base directory.

```text
~/.dsh/plans/YYYY-MM-DD-task-summary-short-id.md
```

The `plan_file` tool creates the initial file and provides `read` and `edit` actions for revisions. An edit supplies the version from the last read and literal `old_text`/`new_text` replacements. The Agent handles these arguments while you give ordinary feedback.

Each session has one plan file. Feedback, session resume, and leaving and re-entering Plan Mode all reuse that file. A fork copies the latest plan content recorded in its inherited history into an independent file for the new session. Small association records live under the plans directory's `.state/` subdirectory. File creation records its identity before publishing the Markdown so an interrupted first write can retry the same path.

## Editing and approval checks

Exact edits preserve text outside their matches, including line endings, a UTF-8 BOM, and the presence or absence of a final newline. Ambiguous matches, overlapping edits, stale versions, and whole-file replacements are rejected. Native filesystem writes to the managed directory are directed to `plan_file`, including nested tool dispatches.

The plugin compares native `exit_plan_mode` input with the saved file and checks the file again before opening review and before returning approval to the native tool. Reads, searches, temporary-directory operations, and other tools retain DSH's existing permissions.

Shell and other independent processes run under their existing DSH permissions. A process with write access to the plans directory can bypass file-tool restrictions. Version checks detect observed external changes. DSH's filesystem backend still has a check-to-publication race with non-cooperating external writers.

## Compatibility

| Plugin version        | Supported DSH versions |
| --------------------- | ---------------------- |
| 0.1.0                 | 0.2.2-rc.3             |
| 0.1.1 (this checkout) | 0.2.2-rc.3             |

The supported DSH version matches `engines.dsh` and the pinned test workspace. GitHub Actions is configured to run native compatibility tests and packed-plugin checks on Linux, macOS, and Windows. Local macOS validation covers the native DSH runtime and real-model Desktop sessions using the standard and PTC presets. Compatibility with dsh-TUI `0.20.1` has also been tested through its `/plan` picker and Shift+Tab read-only mode. Linux sandbox behavior remains unverified.

## Contributing

Development setup, formatting rules, lint commands, and CI checks are documented in [CONTRIBUTING.md](CONTRIBUTING.md).

Version tags trigger package verification, GitHub Release creation, and npm publication when its publishing configuration is enabled. Release previews and account setup are covered in the [release instructions](CONTRIBUTING.md#releases).

MIT licensed.
