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
  const proc = spawn('ttyd', [
    '-p', String(port),
    '-W',
    '-t', 'disableLeaveAlert=true',
    '-t', 'fontSize=16',
    // Claude Code's TUI leans on box-drawing borders, a Braille spinner, and
    // (as of newer releases) Nerd Font/PUA icon codepoints for small status
    // glyphs; most fallback monospace fonts are missing at least one of
    // these, and the browser silently substituting a different font for just
    // that glyph is what causes tofu boxes and - because the substitute
    // often has a different advance width - column desync/clipping for the
    // rest of the line. "DejaVuSansM Nerd Font Mono" is DejaVu Sans Mono
    // patched with the Nerd Font icon set (same metrics, same box-drawing
    // coverage, plus the missing icon range), so nothing falls back - it's
    // vendored locally and loaded into the iframe in app.js. Quoting only
    // the multi-word name (not the whole value, comma included) matters:
    // `'DejaVuSansM Nerd Font Mono', monospace` is a real font list,
    // `'DejaVuSansM Nerd Font Mono, monospace'` is one bogus family name
    // that resolves to nothing.
    '-t', "fontFamily='DejaVuSansM Nerd Font Mono', monospace",
    // xterm's default unicode width table treats a handful of codepoints
    // Claude Code emits (spinner, prompt-box corners) as ambiguous-width,
    // which desyncs column math from what the underlying terminal (and
    // tmux) computed - the visible symptom being shifted/misplaced
    // characters right after those glyphs, worst at the start of the next
    // line. The Unicode11Addon's table fixes that. This is ttyd's own
    // default already, set explicitly so behavior doesn't drift if that
    // default ever changes upstream.
    '-t', 'unicodeVersion=11',
    // WebGL (ttyd's default renderer) and canvas rasterize box-drawing/
    // custom glyphs slightly differently; canvas is the safer choice when
    // border-corner artifacts are the specific complaint.
    '-t', 'rendererType=canvas',
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
