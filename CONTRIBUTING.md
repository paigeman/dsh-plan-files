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

| Command                 | Purpose                                |
| ----------------------- | -------------------------------------- |
| `npm run format`        | Format supported files                 |
| `npm run format:check`  | Check formatting                       |
| `npm run lint:js`       | Check JavaScript and MJS files         |
| `npm run lint:markdown` | Check Markdown                         |
| `npm run lint`          | Run all linters                        |
| `npm run check`         | Check formatting, then run all linters |

To work on selected files, invoke the local tools directly.

```bash
npm exec --no -- prettier --write README.md
npm exec --no -- eslint eslint.config.mjs
npm exec --no -- markdownlint-cli2 README.md
```

Prettier uses two-space indentation, LF line endings, and a print width of 100. Markdown prose keeps its existing line wrapping. Markdown lint permits long lines and repeated headings under different parent sections, and uses fenced code blocks with backticks and asterisks for emphasis.

`node_modules/`, `.agent-tmp/`, and `coverage/` are excluded from Git, formatting, and lint checks. Keep agent-created temporary files under the repository's `.agent-tmp/` directory and track them according to the session's Agent Rules.

## Integration validation

The plugin integrates with DSH's native tools, hooks, and Plan Review flow. Compatibility with a third-party frontend such as dsh-TUI can be checked during acceptance testing of a personal setup.

## CI

GitHub Actions runs `npm ci --ignore-scripts` and `npm run check` on pushes to `main` and pull requests. The workflow checks formatting and lint.
