# claude-harness

My personal Claude Code harness: instructions, skills, subagents and hooks, kept in git and linked into `~/.claude`. Edit files here, start a new session, and the change is live. Every tweak is versioned and easy to roll back.

## Install (Windows, macOS, Linux)

Needs Node 18+ and Claude Code.

```bash
cd ~/git/claude-harness
git init && git add -A && git commit -m "Initial harness"
node install.mjs            # or: --dry-run to preview, --no-mcp to skip Atlassian
```

Then:
1. Open a new Claude Code session and run `/context`. Your personal CLAUDE.md should be listed under Memory files.
2. Run `/mcp`, select `atlassian` and sign in.
3. In each repo, run `/harness-init` once and commit the `CLAUDE.md` and `.claude/checks.json` it creates.

The installer creates links and a one-line import; it never copies files. Re-running it is safe. `node install.mjs --uninstall` removes everything it added and leaves anything that was already there.

On Windows it uses directory junctions, so you don't need admin rights or Developer Mode. If you move this repo, run the installer again.

## What's inside

```text
global/
  CLAUDE.md          personal instructions, imported by ~/.claude/CLAUDE.md
  rules/             path-scoped rules per stack (C#, Python, TS, React); empty until you add lines
  skills/            /spec /handoff /ship /retro /checkup /harness-init /ticket
  agents/            reviewer, researcher, tester, ticket-analyst, ticket-coder
  hooks/             Node scripts wired into ~/.claude/settings.json
install.mjs
```

### Skills (type them as slash commands)

| Command | What it does |
| --- | --- |
| `/harness-init` | Detects the stack, writes `.claude/checks.json` and a lean project CLAUDE.md, gitignores `.work/` |
| `/spec <feature>` | Interviews you, writes `.work/<slug>/spec.md` with testable criteria. Then `/clear` and build |
| `/ticket <KEY>` | Runs a Jira ticket through analyst → coder → reviewer → tester, pausing for your OK at three points |
| `/handoff` | Writes `.work/<task>/progress.md` so you can `/clear` and continue in a fresh session |
| `/ship` | Runs checks, commits, opens the PR |
| `/retro` | Turns this session's corrections into small harness fixes, with your approval |
| `/checkup` | Monthly prune: sizes, conflicts, stale `.work/`, auto memory, unused skills |

### Hooks (run automatically)

| Hook | When | What it does |
| --- | --- | --- |
| `session-start` | Session start | Lists unfinished `.work/` tasks; nudges `/harness-init` if the repo has no checks |
| `protect-files` | Before Read/Edit/Write | Blocks `.env`, keys, certificates, `secrets.json`. Edit the patterns in the file |
| `atlassian-gate` | Before any Atlassian MCP call | Reads pass; comments, edits, transitions and new pages always ask you first |
| `format-edited` | After Edit/Write | Formats and lints the edited file with the project's own tools; remaining lint errors go back to Claude |
| `stop-check` | When Claude finishes | If files changed and `checks.json` has a `stop` command, runs it; a failure sends Claude back to fix it (once) |

`format-edited` uses only tools the project already has: local prettier/eslint in `node_modules/.bin`; ruff from `.venv` or PATH; CSharpier if it's in `.config/dotnet-tools.json`. Anything missing is skipped.

### The Jira pipeline

`/ticket ABC-123` creates `feature/ABC-123-<slug>` and `.work/ABC-123/`, then:

1. **ticket-analyst** reads the ticket and code and writes `01-brief.md` (testable criteria, gaps with recommended defaults, edge cases, draft Jira comments) and `criteria.json`. **You approve** which comments get posted and whether to start.
2. **ticket-coder** implements against the brief and runs the checks → `02-changes.md`.
3. **reviewer** reviews the diff against the brief → `03-review.md`. Blocking findings get one automatic fix round.
4. **tester** verifies each criterion end to end and only it may flip `passes` in `criteria.json` → `04-test-report.md`. **You decide** which gaps go back to the coder.
5. **You approve** the commit and PR.

Each stage runs in a fresh context and reads only the files it needs, so the orchestrating session stays small. If a session ends midway, `/ticket ABC-123` resumes from `progress.md`. Delete `.work/ABC-123/` after the PR merges.

## How to tweak it

| You notice | Change |
| --- | --- |
| Claude repeats a mistake in every project | One line in `global/CLAUDE.md` |
| Claude repeats a mistake in one language | One line in `global/rules/<stack>.md` |
| Claude repeats a mistake in one repo | That repo's `CLAUDE.md` or `.claude/rules/` |
| A rule gets skipped even though it's written down | Turn it into a hook |
| You keep typing the same multi-step request | New folder in `global/skills/`, then re-run `node install.mjs` to link it |
| A pipeline stage is too lenient or too noisy | Edit its file in `global/agents/` |
| Another file should be off-limits | Add a pattern to `global/hooks/protect-files.mjs` |

Run `/retro` after a session where you corrected Claude, and `/checkup` monthly. Keep `global/CLAUDE.md` under about 50 lines.

## Troubleshooting

- **Hooks don't run:** run `/hooks` in Claude Code. Check `node --version` works in the same terminal. Test a hook by hand:
  `echo '{"tool_input":{"file_path":"src/app.ts"}}' | node global/hooks/format-edited.mjs; echo $?`
- **Personal CLAUDE.md not loaded:** `/context` → Memory files. Make sure `~/.claude/CLAUDE.md` contains the `@.../global/CLAUDE.md` line.
- **Atlassian tools missing:** `claude mcp list`. Re-add with `claude mcp add --transport http --scope user atlassian https://mcp.atlassian.com/v2/mcp`, then `/mcp` to sign in. If your org still uses the older endpoint, use `https://mcp.atlassian.com/v1/mcp/authv2`. The gate hook expects the server to be named `atlassian`.
- **Stop check too slow:** make `stop` in `.claude/checks.json` a typecheck/lint only, or remove the key to turn it off for that repo.
