#!/usr/bin/env node
// Installs this harness into your Claude Code user config (~/.claude) without copying files:
//   - links skills and agents/rules folders back to this repo (junctions on Windows: no admin needed)
//   - adds one @import line to ~/.claude/CLAUDE.md pointing at global/CLAUDE.md
//   - merges hooks and permissions into ~/.claude/settings.json (backup first)
//   - adds the Atlassian MCP server at user scope, if the `claude` CLI is on PATH
// Re-running is safe. Edit files in this repo; changes apply on the next Claude Code session.
//
// Usage: node install.mjs [--dry-run] [--no-mcp] [--uninstall]

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const args = new Set(process.argv.slice(2));
const DRY = args.has('--dry-run');
const UNINSTALL = args.has('--uninstall');
const NO_MCP = args.has('--no-mcp');
const isWin = process.platform === 'win32';

const REPO = path.dirname(fileURLToPath(import.meta.url));
const GLOBAL = path.join(REPO, 'global');
const CLAUDE_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const MANIFEST = path.join(CLAUDE_DIR, '.claude-harness.json');
const SETTINGS = path.join(CLAUDE_DIR, 'settings.json');
const CLAUDE_MD = path.join(CLAUDE_DIR, 'CLAUDE.md');
const MARKER = '<!-- claude-harness: personal instructions live in the repo below; edit them there -->';
const ATLASSIAN_URL = 'https://mcp.atlassian.com/v2/mcp';

const posix = (p) => p.split(path.sep).join('/');
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const log = (msg) => console.log(`${DRY ? '[dry-run] ' : ''}${msg}`);

// ---------- links ----------
function plannedLinks() {
  const links = [
    { src: path.join(GLOBAL, 'agents'), dst: path.join(CLAUDE_DIR, 'agents', 'claude-harness') },
    { src: path.join(GLOBAL, 'rules'), dst: path.join(CLAUDE_DIR, 'rules', 'claude-harness') },
  ];
  for (const name of fs.readdirSync(path.join(GLOBAL, 'skills'))) {
    if (fs.statSync(path.join(GLOBAL, 'skills', name)).isDirectory()) {
      links.push({ src: path.join(GLOBAL, 'skills', name), dst: path.join(CLAUDE_DIR, 'skills', name) });
    }
  }
  return links;
}

function isLink(p) {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function linkTarget(p) {
  try {
    return path.resolve(path.dirname(p), fs.readlinkSync(p));
  } catch {
    return null;
  }
}

function makeLink({ src, dst }) {
  if (isLink(dst)) {
    if (path.resolve(linkTarget(dst) || '') === path.resolve(src)) return log(`ok      ${dst}`);
    log(`relink  ${dst}`);
    if (!DRY) fs.rmSync(dst, { recursive: false, force: true });
  } else if (fs.existsSync(dst)) {
    const backup = `${dst}.bak-${stamp}`;
    log(`backup  ${dst} -> ${backup} (a real folder was in the way)`);
    if (!DRY) fs.renameSync(dst, backup);
  } else {
    log(`link    ${dst}`);
  }
  if (!DRY) {
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.symlinkSync(src, dst, isWin ? 'junction' : 'dir');
  }
}

function removeLink(dst) {
  if (isLink(dst)) {
    log(`unlink  ${dst}`);
    if (!DRY) fs.rmSync(dst, { recursive: false, force: true });
  }
}

// ---------- CLAUDE.md import ----------
function importLine() {
  // Imports end at the first unescaped space, so escape spaces (e.g. "C:/Users/First Last/...").
  return `@${posix(path.join(GLOBAL, 'CLAUDE.md')).replace(/ /g, '\\ ')}`;
}

function addImport() {
  const line = importLine();
  const current = fs.existsSync(CLAUDE_MD) ? fs.readFileSync(CLAUDE_MD, 'utf8') : '';
  if (current.includes(MARKER)) {
    const updated = current.replace(new RegExp(`${escapeRe(MARKER)}\\r?\\n@[^\\r\\n]*`), `${MARKER}\n${line}`);
    if (updated !== current) {
      log(`update  import in ${CLAUDE_MD}`);
      if (!DRY) fs.writeFileSync(CLAUDE_MD, updated);
    } else log(`ok      import in ${CLAUDE_MD}`);
    return;
  }
  log(`${current ? 'append' : 'create'}  import in ${CLAUDE_MD}`);
  const block = `${current && !current.endsWith('\n') ? '\n' : ''}${current ? '\n' : ''}${MARKER}\n${line}\n`;
  if (!DRY) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(CLAUDE_MD, current + block);
  }
}

function removeImport() {
  if (!fs.existsSync(CLAUDE_MD)) return;
  const current = fs.readFileSync(CLAUDE_MD, 'utf8');
  const updated = current.replace(new RegExp(`\\r?\\n?${escapeRe(MARKER)}\\r?\\n@[^\\r\\n]*\\r?\\n?`), '\n');
  if (updated !== current) {
    log(`remove  import from ${CLAUDE_MD}`);
    if (!DRY) fs.writeFileSync(CLAUDE_MD, updated.trim() ? updated.replace(/\n{3,}/g, '\n\n') : '');
  }
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// ---------- settings.json ----------
const HOOK_FILES = ['session-start.mjs', 'protect-files.mjs', 'atlassian-gate.mjs', 'format-edited.mjs', 'stop-check.mjs'];
const hookCmd = (file) => `node "${posix(path.join(GLOBAL, 'hooks', file))}"`;
const isOurs = (cmd = '') => cmd.includes('/global/hooks/') && HOOK_FILES.some((f) => cmd.includes(f));

function ourHooks() {
  return {
    SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('session-start.mjs'), timeout: 10 }] }],
    PreToolUse: [
      { matcher: 'Read|Edit|Write|MultiEdit', hooks: [{ type: 'command', command: hookCmd('protect-files.mjs'), timeout: 10 }] },
      { matcher: 'mcp__atlassian__.*', hooks: [{ type: 'command', command: hookCmd('atlassian-gate.mjs'), timeout: 10 }] },
    ],
    PostToolUse: [
      { matcher: 'Edit|Write|MultiEdit', hooks: [{ type: 'command', command: hookCmd('format-edited.mjs'), timeout: 90 }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: hookCmd('stop-check.mjs'), timeout: 600 }] }],
  };
}

const ALLOW = [
  'Bash(git status)', 'Bash(git status *)', 'Bash(git diff)', 'Bash(git diff *)', 'Bash(git log *)',
  'Bash(git show *)', 'Bash(git branch)', 'Bash(git branch --show-current)',
  'Bash(dotnet build *)', 'Bash(dotnet test *)', 'Bash(dotnet format *)',
  'Bash(npm test)', 'Bash(npm test *)', 'Bash(npm run lint *)', 'Bash(npm run lint)', 'Bash(npm run typecheck)',
  'Bash(npx tsc --noEmit *)', 'Bash(npx tsc --noEmit)',
  'Bash(pytest *)', 'Bash(uv run pytest *)', 'Bash(ruff check *)', 'Bash(ruff format *)',
  'Bash(uv run ruff *)', 'Bash(gh pr view *)', 'Bash(gh pr diff *)',
];
const DENY = ['Bash(git push --force *)', 'Bash(git push -f *)', 'Bash(git reset --hard *)', 'Bash(git clean -fd *)'];

function readSettings() {
  if (!fs.existsSync(SETTINGS)) return {};
  const raw = fs.readFileSync(SETTINGS, 'utf8');
  try {
    return raw.trim() ? JSON.parse(raw) : {};
  } catch {
    throw new Error(`${SETTINGS} isn't valid JSON. Fix it (or move it aside) and run the installer again.`);
  }
}

function stripOurHooks(hooks = {}) {
  const out = {};
  for (const [event, groups] of Object.entries(hooks)) {
    const kept = (groups || [])
      .map((g) => ({ ...g, hooks: (g.hooks || []).filter((h) => !isOurs(h.command)) }))
      .filter((g) => g.hooks.length);
    if (kept.length) out[event] = kept;
  }
  return out;
}

function writeSettings(settings, reason) {
  const next = `${JSON.stringify(settings, null, 2)}\n`;
  if (fs.existsSync(SETTINGS) && fs.readFileSync(SETTINGS, 'utf8') === next) return log(`ok      ${SETTINGS}`);
  if (fs.existsSync(SETTINGS)) {
    const backup = `${SETTINGS}.bak-${stamp}`;
    log(`backup  ${SETTINGS} -> ${path.basename(backup)}`);
    if (!DRY) fs.copyFileSync(SETTINGS, backup);
  }
  log(`write   ${SETTINGS} (${reason})`);
  if (!DRY) {
    fs.mkdirSync(CLAUDE_DIR, { recursive: true });
    fs.writeFileSync(SETTINGS, next);
  }
}

function mergeSettings(manifest) {
  const settings = readSettings();
  const hooks = stripOurHooks(settings.hooks);
  for (const [event, groups] of Object.entries(ourHooks())) hooks[event] = [...(hooks[event] || []), ...groups];
  settings.hooks = hooks;

  settings.permissions ||= {};
  const added = { allow: [], deny: [] };
  for (const [key, rules] of [['allow', ALLOW], ['deny', DENY]]) {
    const list = new Set(settings.permissions[key] || []);
    for (const r of rules) {
      if (!list.has(r)) {
        list.add(r);
        added[key].push(r);
      }
    }
    settings.permissions[key] = [...list];
  }
  // Remember only what we added, so uninstall never removes rules you had before.
  manifest.addedAllow = [...new Set([...(manifest.addedAllow || []), ...added.allow])];
  manifest.addedDeny = [...new Set([...(manifest.addedDeny || []), ...added.deny])];
  writeSettings(settings, `hooks + ${added.allow.length + added.deny.length} new permission rules`);
}

function unmergeSettings(manifest) {
  if (!fs.existsSync(SETTINGS)) return;
  const settings = readSettings();
  settings.hooks = stripOurHooks(settings.hooks);
  if (!Object.keys(settings.hooks).length) delete settings.hooks;
  if (settings.permissions) {
    const drop = (list = [], remove = []) => list.filter((r) => !remove.includes(r));
    settings.permissions.allow = drop(settings.permissions.allow, manifest.addedAllow);
    settings.permissions.deny = drop(settings.permissions.deny, manifest.addedDeny);
    for (const k of ['allow', 'deny']) if (!settings.permissions[k].length) delete settings.permissions[k];
    if (!Object.keys(settings.permissions).length) delete settings.permissions;
  }
  writeSettings(settings, 'removed harness hooks and permissions');
}

// ---------- Atlassian MCP ----------
function claude(argv) {
  const res = isWin
    ? spawnSync(`claude ${argv.map((a) => (/\s/.test(a) ? `"${a}"` : a)).join(' ')}`, { shell: true, encoding: 'utf8' })
    : spawnSync('claude', argv, { encoding: 'utf8' });
  return { ok: res.status === 0 && !res.error, missing: res.error?.code === 'ENOENT' || /not recognized|not found/i.test(res.stderr || '') };
}

function addAtlassian() {
  if (NO_MCP) return log('skip    Atlassian MCP (--no-mcp)');
  const probe = claude(['mcp', 'get', 'atlassian']);
  if (probe.missing) return log(`skip    Atlassian MCP: 'claude' CLI not on PATH. Later run: claude mcp add --transport http --scope user atlassian ${ATLASSIAN_URL}`);
  if (probe.ok) return log('ok      Atlassian MCP already configured');
  log('add     Atlassian MCP server (user scope)');
  if (DRY) return;
  const res = claude(['mcp', 'add', '--transport', 'http', '--scope', 'user', 'atlassian', ATLASSIAN_URL]);
  log(res.ok ? '        then run /mcp inside Claude Code and sign in to Atlassian' : `        failed; run it yourself: claude mcp add --transport http --scope user atlassian ${ATLASSIAN_URL}`);
}

// ---------- main ----------
function main() {
  const manifest = fs.existsSync(MANIFEST) ? JSON.parse(fs.readFileSync(MANIFEST, 'utf8')) : {};
  console.log(`claude-harness ${UNINSTALL ? 'uninstall' : 'install'}\n  repo:   ${REPO}\n  config: ${CLAUDE_DIR}\n`);

  if (UNINSTALL) {
    for (const dst of manifest.links || plannedLinks().map((l) => l.dst)) removeLink(dst);
    removeImport();
    unmergeSettings(manifest);
    log(`remove  ${MANIFEST}`);
    if (!DRY && fs.existsSync(MANIFEST)) fs.rmSync(MANIFEST);
    console.log('\nDone. The Atlassian MCP server was left in place (remove with: claude mcp remove atlassian -s user).');
    return;
  }

  const links = plannedLinks();
  for (const l of links) makeLink(l);
  addImport();
  mergeSettings(manifest);
  addAtlassian();

  Object.assign(manifest, { repo: REPO, links: links.map((l) => l.dst), installedAt: new Date().toISOString() });
  if (!DRY) fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`);

  console.log(`
Done. Next:
  1. Start a new Claude Code session and run /context to confirm the personal CLAUDE.md loaded.
  2. Run /mcp and sign in to Atlassian.
  3. In each repo you work in, run /harness-init once.`);
}

try {
  main();
} catch (err) {
  console.error(`\nInstall failed: ${err.message}`);
  process.exit(1);
}
