const express = require('express');
const http = require('http');
const httpProxy = require('http-proxy');
const path = require('path');

const { getOrStartSession, listProjects, safeProjectDir, stopProjectSessions } = require('./ttydManager');
const fileApi = require('./fileApi');

const PORT = parseInt(process.env.PORT || '8080', 10);
const app = express();
app.use(express.json({ limit: '4mb' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

const proxy = httpProxy.createProxyServer({ ws: true });
proxy.on('error', (err, req, res) => {
  console.error('proxy error', err.message);
  if (res && res.writeHead) {
    res.writeHead(502, { 'Content-Type': 'text/plain' });
    res.end('Terminal session is not available yet, try again in a moment.');
  }
});

// --- Projects ---

app.get('/api/projects', (req, res) => {
  try {
    res.json(listProjects());
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/session/:project/start', async (req, res) => {
  try {
    const kind = req.query.kind === 'shell' ? 'shell' : 'claude';
    const port = await getOrStartSession(req.params.project, kind);
    res.json({ ok: true, port });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.post('/api/session/:project/stop', (req, res) => {
  try {
    stopProjectSessions(req.params.project);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Files ---

app.get('/api/tree/:project', (req, res) => {
  try {
    const dir = safeProjectDir(req.params.project);
    res.json(fileApi.getTree(dir, req.query.path || '.'));
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.get('/api/file/:project', (req, res) => {
  try {
    const dir = safeProjectDir(req.params.project);
    res.json({ content: fileApi.readFile(dir, req.query.path) });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

app.put('/api/file/:project', (req, res) => {
  try {
    const dir = safeProjectDir(req.params.project);
    fileApi.writeFile(dir, req.body.path, req.body.content);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Streams the file's raw bytes with a Content-Disposition: attachment header,
// instead of round-tripping it through JSON as UTF-8 text (see readFile) -
// that round-trip silently corrupts binary files (images, zips, etc).
app.get('/api/file/:project/raw', (req, res) => {
  try {
    const dir = safeProjectDir(req.params.project);
    const file = fileApi.resolveForDownload(dir, req.query.path);
    res.download(file, path.basename(file), (err) => {
      if (err && !res.headersSent) {
        res.status(404).json({ error: 'file not found' });
      }
    });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// Raw binary body, scoped to this route only so it doesn't shadow the
// express.json() parsing used everywhere else. `type: '*/*'` accepts
// uploads regardless of the browser-guessed Content-Type (or its absence).
app.post('/api/upload/:project', express.raw({ limit: '20mb', type: '*/*' }), (req, res) => {
  try {
    const dir = safeProjectDir(req.params.project);
    const relPath = req.query.path;
    if (!relPath) throw new Error('missing path');
    if (req.query.overwrite !== 'true' && fileApi.exists(dir, relPath)) {
      return res.status(409).json({ error: 'exists' });
    }
    fileApi.writeFile(dir, relPath, req.body);
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// --- Terminal proxies ---
// /term/<project>/...  -> the project's Claude Code ttyd instance
// /shell/<project>/... -> a plain shell ttyd instance in the project dir

app.use('/term/:project', async (req, res) => {
  try {
    const port = await getOrStartSession(req.params.project, 'claude');
    // Strip the /term/<project> prefix so ttyd sees paths as if it were root.
    req.url = req.originalUrl.replace(`/term/${req.params.project}`, '') || '/';
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  } catch (err) {
    res.status(400).send(err.message);
  }
});

app.use('/shell/:project', async (req, res) => {
  try {
    const port = await getOrStartSession(req.params.project, 'shell');
    req.url = req.originalUrl.replace(`/shell/${req.params.project}`, '') || '/';
    proxy.web(req, res, { target: `http://127.0.0.1:${port}` });
  } catch (err) {
    res.status(400).send(err.message);
  }
});

const server = http.createServer(app);

// WebSocket upgrades (ttyd's actual terminal stream) need handling separately.
server.on('upgrade', async (req, socket, head) => {
  const match = req.url.match(/^\/(term|shell)\/([^/]+)(\/.*)?$/);
  if (!match) { socket.destroy(); return; }
  const kind = match[1] === 'shell' ? 'shell' : 'claude';
  const project = match[2];
  try {
    const port = await getOrStartSession(project, kind);
    req.url = match[3] || '/';
    proxy.ws(req, socket, head, { target: `http://127.0.0.1:${port}` });
  } catch (err) {
    socket.destroy();
  }
});

server.listen(PORT, () => {
  console.log(`Hub listening on :${PORT}, workspace = ${process.env.WORKSPACE_DIR}`);
});
