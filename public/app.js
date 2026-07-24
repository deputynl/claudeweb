let currentProject = null;
let currentFile = null;
let viewMode = 'code';

const codeMirror = CodeMirror(document.getElementById('code-editor'), {
  value: '',
  lineNumbers: true,
  theme: 'hub',
  mode: null,
  readOnly: false,
});

const MODE_BY_EXT = {
  js: 'javascript', jsx: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: { name: 'javascript', typescript: true }, tsx: { name: 'javascript', typescript: true },
  json: { name: 'javascript', json: true },
  css: 'css', scss: 'css', less: 'css',
  html: 'htmlmixed', htm: 'htmlmixed',
  xml: 'xml', svg: 'xml',
  md: 'markdown', markdown: 'markdown',
  py: 'python',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  yml: 'yaml', yaml: 'yaml',
  sql: 'sql',
  c: 'text/x-csrc', h: 'text/x-csrc',
  cpp: 'text/x-c++src', hpp: 'text/x-c++src', cc: 'text/x-c++src',
  java: 'text/x-java', cs: 'text/x-csharp',
};

function escapeHtmlAttr(s) {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;');
}

// Registry of renderable file types: add an entry here to get a Code/Preview
// toggle (defaulting to Preview) for that file type.
const PREVIEW_RENDERERS = [
  { test: (p) => /\.(md|markdown)$/i.test(p), render: (content) => marked.parse(content) },
  {
    test: (p) => /\.html?$/i.test(p),
    // srcdoc (not a blob/data URL) keeps the preview same-document, and the
    // sandbox omits allow-same-origin so previewed scripts can't reach back
    // into this app's page or storage — they get an opaque, isolated origin.
    render: (content) =>
      `<iframe class="html-preview-frame" sandbox="allow-scripts allow-forms allow-modals allow-popups" srcdoc="${escapeHtmlAttr(content)}"></iframe>`,
  },
];

let currentRenderer = null;

function modeForPath(relPath) {
  const base = relPath.split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return 'dockerfile';
  const ext = base.split('.').pop();
  return MODE_BY_EXT[ext] || null;
}

function rendererForPath(relPath) {
  const entry = PREVIEW_RENDERERS.find((r) => r.test(relPath));
  return entry ? entry.render : null;
}

function setViewMode(mode) {
  viewMode = mode;
  document.querySelectorAll('#md-toggle .seg-btn').forEach((b) => b.classList.toggle('active', b.dataset.mode === mode));
  document.getElementById('code-editor').hidden = mode !== 'code';
  document.getElementById('md-preview').hidden = mode !== 'preview';
  if (mode === 'preview' && currentRenderer) {
    document.getElementById('md-preview').innerHTML = currentRenderer(codeMirror.getValue());
  } else {
    codeMirror.refresh();
  }
}

document.querySelectorAll('#md-toggle .seg-btn').forEach((btn) => {
  btn.addEventListener('click', () => setViewMode(btn.dataset.mode));
});

async function loadProjects() {
  const res = await fetch('/api/projects');
  const projects = await res.json();
  const list = document.getElementById('project-list');
  list.innerHTML = '';
  for (const p of projects) {
    const li = document.createElement('li');
    li.textContent = p.name;
    li.dataset.name = p.name;
    if (p.name === currentProject) li.classList.add('active');
    const dot = document.createElement('span');
    dot.className = 'dot' + (p.running ? ' running' : '');
    li.appendChild(dot);
    li.addEventListener('click', () => selectProject(p.name));
    list.appendChild(li);
  }
}

// ttyd serves its own document into these iframes, but same-origin (proxied
// through /term/ and /shell/) means we can reach into it and inject our own
// styling: scrollbars to match the rest of the app, and a @font-face for the
// terminal font. The latter matters because ttyd is started with
// fontFamily="'DejaVu Sans Mono', monospace" (see ttydManager.js) but that
// name is only meaningful if the same font is actually loaded in this
// document - without it, each client's browser would fall back to whatever
// "DejaVu Sans Mono" (or its next fallback) resolves to locally, which is
// exactly the kind of per-client font substitution that causes glyph/
// cell-width mismatches.
function styleTerminalFrame(iframe) {
  iframe.addEventListener('load', () => {
    let doc;
    try {
      doc = iframe.contentDocument;
    } catch (e) {
      return; // not same-origin (e.g. about:blank in some browsers) - skip
    }
    if (!doc || !doc.head) return;
    const style = doc.createElement('style');
    style.textContent = `
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono.ttf') format('truetype');
        font-weight: normal;
        font-style: normal;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-Bold.ttf') format('truetype');
        font-weight: bold;
        font-style: normal;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-Oblique.ttf') format('truetype');
        font-weight: normal;
        font-style: italic;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-BoldOblique.ttf') format('truetype');
        font-weight: bold;
        font-style: italic;
      }

      * { scrollbar-width: thin; scrollbar-color: #3e3d38 transparent; }
      *::-webkit-scrollbar { width: 10px; height: 10px; }
      *::-webkit-scrollbar-track { background: transparent; }
      *::-webkit-scrollbar-thumb {
        background-color: #3e3d38;
        border-radius: 6px;
        border: 2px solid transparent;
        background-clip: padding-box;
      }
      *::-webkit-scrollbar-thumb:hover { background-color: #7a7870; background-clip: padding-box; }
      *::-webkit-scrollbar-corner { background: transparent; }
    `;
    doc.head.appendChild(style);

    // ttyd's canvas renderer measures glyph widths against whatever font is
    // actually loaded at the moment it initializes, which can race ahead of
    // this @font-face's own network fetch. Once the real font finishes
    // loading, force a resize so ttyd's fit addon (bound to window resize)
    // remeasures and repaints with correct metrics instead of leaving
    // stale, fallback-font-derived column widths in place.
    if (doc.fonts && doc.fonts.load) {
      doc.fonts.load("16px 'DejaVu Sans Mono'").catch(() => {}).then(() => {
        try {
          iframe.contentWindow.dispatchEvent(new Event('resize'));
        } catch (e) {
          // iframe navigated away already - nothing to fix up
        }
      });
    }
  });
}
styleTerminalFrame(document.getElementById('claude-frame'));
styleTerminalFrame(document.getElementById('shell-frame'));

let currentTab = 'claude';

async function selectProject(name) {
  currentProject = name;
  currentFile = null;
  document.getElementById('empty-state').hidden = true;
  document.getElementById('project-view').hidden = false;
  document.getElementById('current-project').textContent = name;
  document.querySelectorAll('#project-list li').forEach((li) => {
    li.classList.toggle('active', li.dataset.name === name);
  });

  // Kick off (or reattach to) the tmux session, then point the iframe at it.
  await fetch(`/api/session/${encodeURIComponent(name)}/start`, { method: 'POST' });
  document.getElementById('claude-frame').src = `/term/${encodeURIComponent(name)}/`;

  // The shell session is started lazily (only once the Terminal tab is
  // actually opened) rather than eagerly like Claude Code's, so switching
  // projects just resets it here; ensureShellStarted() re-arms it below.
  const shellFrame = document.getElementById('shell-frame');
  shellFrame.src = 'about:blank';
  delete shellFrame.dataset.loadedFor;
  if (currentTab === 'shell') await ensureShellStarted();

  await loadFileTree();
  loadProjects(); // refresh running-dot state
}

async function ensureShellStarted() {
  const frame = document.getElementById('shell-frame');
  if (!currentProject || frame.dataset.loadedFor === currentProject) return;
  await fetch(`/api/session/${encodeURIComponent(currentProject)}/start?kind=shell`, { method: 'POST' });
  frame.src = `/shell/${encodeURIComponent(currentProject)}/`;
  frame.dataset.loadedFor = currentProject;
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tab-claude').hidden = tab !== 'claude';
  document.getElementById('tab-shell').hidden = tab !== 'shell';
  document.getElementById('tab-files').hidden = tab !== 'files';
  if (tab === 'files') codeMirror.refresh();
  if (tab === 'shell') ensureShellStarted();
}

document.querySelectorAll('.tab-btn').forEach((btn) => {
  btn.addEventListener('click', () => switchTab(btn.dataset.tab));
});

// --- Files ---

async function loadFileTree() {
  const res = await fetch(`/api/tree/${encodeURIComponent(currentProject)}`);
  const tree = await res.json();
  const container = document.getElementById('file-tree');
  container.innerHTML = '';
  container.appendChild(renderTree(tree));
}

const ICON_FOLDER = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>';
const ICON_FILE = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/></svg>';

function renderTree(nodes) {
  const ul = document.createElement('ul');
  for (const node of nodes) {
    const li = document.createElement('li');
    const icon = document.createElement('span');
    icon.className = 'tree-icon';
    icon.innerHTML = node.type === 'dir' ? ICON_FOLDER : ICON_FILE;
    li.appendChild(icon);
    li.appendChild(document.createTextNode(node.name));
    if (node.type === 'dir') {
      li.appendChild(renderTree(node.children));
    } else {
      li.dataset.path = node.path;
      li.classList.toggle('selected', node.path === currentFile);
      li.addEventListener('click', (e) => { e.stopPropagation(); openFile(node.path); });
    }
    ul.appendChild(li);
  }
  return ul;
}

async function openFile(relPath) {
  const res = await fetch(`/api/file/${encodeURIComponent(currentProject)}?path=${encodeURIComponent(relPath)}`);
  if (!res.ok) return;
  const data = await res.json();
  currentFile = relPath;
  document.getElementById('file-path').textContent = relPath;
  document.getElementById('save-btn').disabled = false;
  document.getElementById('download-btn').disabled = false;
  document.getElementById('save-status').textContent = '';
  document.querySelectorAll('#file-tree li').forEach((li) => {
    if (li.dataset.path) li.classList.toggle('selected', li.dataset.path === relPath);
  });

  codeMirror.setValue(data.content);
  codeMirror.clearHistory();
  codeMirror.setOption('mode', modeForPath(relPath));

  currentRenderer = rendererForPath(relPath);
  document.getElementById('md-toggle').hidden = !currentRenderer;
  setViewMode(currentRenderer ? 'preview' : 'code');
}

document.getElementById('save-btn').addEventListener('click', async () => {
  if (!currentFile) return;
  const content = codeMirror.getValue();
  const res = await fetch(`/api/file/${encodeURIComponent(currentProject)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentFile, content }),
  });
  document.getElementById('save-status').textContent = res.ok ? 'Saved' : 'Save failed';
});

document.getElementById('download-btn').addEventListener('click', () => {
  if (!currentFile) return;
  const blob = new Blob([codeMirror.getValue()], { type: 'text/plain' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = currentFile.split('/').pop();
  document.body.appendChild(a);
  a.click();
  a.remove();
  URL.revokeObjectURL(url);
});

loadProjects();
