const { spawn, spawnSync } = require('child_process');
const net = require('net');
const path = require('path');
const fs = require('fs');

const WORKSPACE_DIR = process.env.WORKSPACE_DIR || '/workspace';
const PORT_BASE = parseInt(process.env.TTYD_PORT_BASE || '7700', 10);

// "<project>:<kind>" -> { port, proc }, kind is 'claude' or 'shell'
const sessions = new Map();
let nextPort = PORT_BASE;

function safeProjectDir(project) {
  // Guard against path traversal via the project name itself.
  if (!project || project.includes('..') || project.includes('/') || project.includes('\\')) {
    throw new Error('invalid project name');
  }
  const dir = path.join(WORKSPACE_DIR, project);
  const resolved = path.resolve(dir);
  if (!resolved.startsWith(path.resolve(WORKSPACE_DIR) + path.sep)) {
    throw new Error('invalid project path');
  }
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    throw new Error('project folder not found');
  }
  return resolved;
}

function waitForPort(port, timeoutMs = 8000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryConnect = () => {
      const socket = net.createConnection(port, '127.0.0.1');
      socket.once('connect', () => { socket.destroy(); resolve(); });
      socket.once('error', () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) return reject(new Error('ttyd did not start in time'));
        setTimeout(tryConnect, 150);
      });
    };
    tryConnect();
  });
}

// Returns the local port this project's ttyd instance is listening on,
// starting it if it isn't running yet. `kind` picks what runs inside the
// tmux session: 'claude' (default) launches Claude Code directly; 'shell'
// drops into a plain login shell in the project directory.
async function getOrStartSession(project, kind = 'claude') {
  const key = `${project}:${kind}`;
  const existing = sessions.get(key);
  if (existing) return existing.port;

  const dir = safeProjectDir(project);
  const port = nextPort++;
  // Separate tmux session name per kind so "claude" and "shell" for the same
  // project don't collide/attach to each other.
  const sessionName = kind === 'shell' ? `${project}__shell` : project;
  const tmuxArgs = ['tmux', '-f', '/etc/tmux.conf', 'new-session', '-A', '-s', sessionName, '-c', dir];
  if (kind !== 'shell') tmuxArgs.push('claude', '--permission-mode', 'auto');

  // tmux new-session -A: attach if a session with this name already exists,
  // otherwise create it. This is what makes reconnects survive dropped
  // connections - only the terminal view goes away, not the underlying process.
  const proc = spawn('ttyd', [
    '-p', String(port),
    '-W',
    '-t', 'disableLeaveAlert=true',
    '-t', 'fontSize=12',
    // Vendored so terminal text renders identically regardless of what's
    // installed client-side, matched by the @font-face injected into the
    // iframe in app.js - not what fixes box-drawing corners (that's the
    // LANG fix below; xterm's own vector renderer draws those once real
    // Unicode is flowing, independent of font). Plain DejaVu Sans Mono, not
    // a Nerd Font build: Claude Code's TUI doesn't use PUA/Nerd Font icon
    // codepoints. ttyd drops everything after the first comma in a -t
    // value, so no ", monospace" fallback here - it would be a no-op.
    '-t', "fontFamily='DejaVu Sans Mono'",
    ...tmuxArgs,
  ], {
    stdio: 'inherit',
    // Without a UTF-8 locale, Claude Code's TUI can't confirm the terminal
    // supports Unicode and falls back to a degraded ASCII/VT100-line-drawing
    // rendering for box borders: a literal "_" for each corner plus DEC
    // Special Graphics line-drawing bytes, instead of real "╭─╮" etc
    // (confirmed by inspecting the raw pty output over the websocket). That
    // fallback's corners never actually look like corners in xterm.js - an
    // underscore glyph (drawn at the font's baseline) and a separately
    // vector-drawn horizontal line (drawn at the cell's vertical center)
    // don't visually connect, regardless of font/renderer. node:20-slim has
    // no locale configured at all (`locale -a` only lists C/C.utf8/POSIX)
    // and doesn't need one installed - C.utf8 is already there, just unused.
    env: { ...process.env, LANG: 'C.UTF-8', LC_ALL: 'C.UTF-8' },
  });

  proc.on('exit', (code) => {
    console.log(`ttyd for project "${project}" (${kind}) exited (code ${code})`);
    sessions.delete(key);
  });

  sessions.set(key, { port, proc });
  await waitForPort(port);
  return port;
}

// Ends both tmux sessions ("claude" and "shell") for a project. tmux
// sessions are created with `new-session -A` so they normally outlive their
// ttyd process (that's what makes reconnects survive dropped connections) -
// killing just the ttyd proc would leave the tmux session (and whatever's
// running inside it, e.g. Claude Code) alive in the background. So this
// kills the tmux session directly via `tmux kill-session`, then also kills
// the tracked ttyd proc so the next visit spawns a fresh pair instead of
// proxying to a stale one.
function stopProjectSessions(project) {
  for (const kind of ['claude', 'shell']) {
    const key = `${project}:${kind}`;
    const sessionName = kind === 'shell' ? `${project}__shell` : project;
    spawnSync('tmux', ['-f', '/etc/tmux.conf', 'kill-session', '-t', sessionName]);

    const existing = sessions.get(key);
    if (existing) {
      existing.proc.kill();
      sessions.delete(key);
    }
  }
}

function listProjects() {
  return fs.readdirSync(WORKSPACE_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith('.'))
    .map((d) => ({
      name: d.name,
      running: sessions.has(`${d.name}:claude`),
    }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

module.exports = { getOrStartSession, listProjects, safeProjectDir, stopProjectSessions };
