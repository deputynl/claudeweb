const { spawn } = require('child_process');
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
  // Explicit fontFamily so Claude Code's box-drawing banner and prompt glyph
  // (neither of which is plain ASCII) don't fall back to tofu/underscore
  // placeholders when the browser's default monospace font lacks them.
  // DejaVu Sans Mono has the broadest Unicode coverage (box drawing, braille
  // spinners, symbols) of any common monospace font and ships by default on
  // most Linux desktops; the fallbacks cover Windows Terminal (Cascadia),
  // classic Windows (Consolas) and macOS (Menlo) in case DejaVu isn't
  // installed client-side.
  const FONT_FAMILY = '"DejaVu Sans Mono", "Cascadia Mono", "Cascadia Code", Consolas, Menlo, monospace';

  const proc = spawn('ttyd', [
    '-p', String(port),
    '-W',
    '-t', 'disableLeaveAlert=true',
    '-t', 'fontSize=16',
    '-t', `fontFamily=${FONT_FAMILY}`,
    ...tmuxArgs,
  ], { stdio: 'inherit' });

  proc.on('exit', (code) => {
    console.log(`ttyd for project "${project}" (${kind}) exited (code ${code})`);
    sessions.delete(key);
  });

  sessions.set(key, { port, proc });
  await waitForPort(port);
  return port;
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

module.exports = { getOrStartSession, listProjects, safeProjectDir };
