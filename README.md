# Plan Files for DeepSeek Harness

[中文说明](README.zh-CN.md)

DSH Plan Files is a planned DeepSeek Harness (DSH) plugin for keeping plans in independent Markdown files while using DSH's native Plan Review.

The project is in investigation and design. This checkout provides formatting and lint tooling. The workflow below describes the intended plugin behavior.

## Planned workflow

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

The design retains the native `/plan`, `exit_plan_mode`, **Approve**, **Keep planning**, and feedback flow.

## Plan files

Plans are intended to live in `~/.dsh/plans/`, with names following this pattern.

```text
~/.dsh/plans/YYYY-MM-DD-task-summary-short-id.md
```

The first review uses an already saved file. Each later review must match the current file contents, and approval retains that file. File association needs to cover resumed sessions, parallel sessions, multiple plans in one session, forks, external edits, and interrupted writes.

The proposed implementation uses localized file editing followed by native `exit_plan_mode`. Additional permission checks focus on the current plan file's writes and review submission. Other tools use DSH's existing permissions.

## Compatibility investigation

Static source inspection used the following versions and commits.

| Component | Investigated version | Source commit                                                                                            |
| --------- | -------------------- | -------------------------------------------------------------------------------------------------------- |
| DSH       | `0.2.2-rc.3`         | [38a6a5c](https://github.com/deepseek-ai/deepseek-harness/tree/38a6a5c965aa99ab525161efb7cc5cf1fe62fced) |

End-to-end behavior and Linux sandbox enforcement still require validation in an isolated test environment.

## Contributing

Development setup, formatting rules, lint commands, and CI checks are documented in [CONTRIBUTING.md](CONTRIBUTING.md).
