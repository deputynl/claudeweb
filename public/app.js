import {
  EditorState, EditorView, Compartment, keymap, lineNumbers, drawSelection,
  defaultKeymap, history, historyKeymap, bracketMatching, syntaxHighlighting,
  HighlightStyle, search, searchKeymap, tags, languages,
} from './vendor/codemirror6/codemirror6.bundle.js';

let currentProject = null;
let currentFile = null;
let viewMode = 'code';

// Token colors, matched to the rest of the UI. Chrome (background, gutters,
// cursor, search panel, ...) is themed with plain CSS in styles.css against
// CM6's stable default class names - only per-token syntax colors need the
// @lezer/highlight `tags` API, which is JS-only.
const highlightStyle = HighlightStyle.define([
  { tag: tags.comment, color: 'var(--text-faint)', fontStyle: 'italic' },
  { tag: tags.keyword, color: 'var(--syn-keyword)' },
  { tag: [tags.atom, tags.number, tags.bool], color: 'var(--syn-number)' },
  { tag: [tags.string, tags.special(tags.string)], color: 'var(--syn-string)' },
  { tag: [tags.propertyName, tags.attributeName], color: 'var(--syn-property)' },
  { tag: [tags.typeName, tags.definition(tags.variableName)], color: 'var(--text)' },
  { tag: tags.tagName, color: 'var(--syn-keyword)' },
  { tag: tags.meta, color: 'var(--text-dim)' },
  { tag: tags.operator, color: 'var(--text-dim)' },
  { tag: tags.heading, color: 'var(--accent)', fontWeight: '600' },
  { tag: [tags.link, tags.url], color: 'var(--syn-property)' },
]);

// Reconfigurable per open file - see openFile().
const languageCompartment = new Compartment();

// Building a fresh EditorState per file (rather than dispatching a change
// transaction into the existing one) resets undo history for free, matching
// CM5's explicit clearHistory() call on file open.
function createEditorState(doc, relPath) {
  return EditorState.create({
    doc,
    extensions: [
      lineNumbers(),
      drawSelection(),
      bracketMatching(),
      history(),
      search(),
      syntaxHighlighting(highlightStyle),
      keymap.of([...defaultKeymap, ...historyKeymap, ...searchKeymap]),
      languageCompartment.of(relPath ? languageForPath(relPath) : []),
    ],
  });
}

const codeMirror = new EditorView({
  parent: document.getElementById('code-editor'),
  state: createEditorState(''),
});

const MODE_BY_EXT = {
  js: languages.javascript, jsx: languages.jsx, mjs: languages.javascript, cjs: languages.javascript,
  ts: languages.typescript, tsx: languages.tsx,
  json: languages.json,
  css: languages.css, scss: languages.css, less: languages.css,
  html: languages.html, htm: languages.html,
  xml: languages.xml, svg: languages.xml,
  md: languages.markdown, markdown: languages.markdown,
  py: languages.python,
  sh: languages.shell, bash: languages.shell, zsh: languages.shell,
  yml: languages.yaml, yaml: languages.yaml,
  sql: languages.sql,
  c: languages.cpp, h: languages.cpp,
  cpp: languages.cpp, hpp: languages.cpp, cc: languages.cpp,
  java: languages.java, cs: languages.csharp,
  dockerfile: languages.dockerfile,
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

function languageForPath(relPath) {
  const base = relPath.split('/').pop().toLowerCase();
  if (base === 'dockerfile' || base.startsWith('dockerfile.')) return languages.dockerfile();
  const ext = base.split('.').pop();
  const factory = MODE_BY_EXT[ext];
  return factory ? factory() : [];
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
    document.getElementById('md-preview').innerHTML = currentRenderer(codeMirror.state.doc.toString());
  } else {
    codeMirror.requestMeasure();
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
// fontFamily='DejaVu Sans Mono' (see ttydManager.js) but that name is only
// meaningful if the same font is actually loaded in this document -
// otherwise each client falls back to whatever "DejaVu Sans Mono"/monospace
// resolves to locally. This keeps regular terminal text consistent across
// clients; it's not what makes Claude Code's box-drawing panel borders
// render correctly (that depends on the container having a UTF-8 locale -
// see the LANG/LC_ALL comment in ttydManager.js - once real Unicode box
// characters are sent, xterm's own vector renderer draws them regardless
// of font).
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
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono.woff2') format('woff2');
        font-weight: normal;
        font-style: normal;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-Bold.woff2') format('woff2');
        font-weight: bold;
        font-style: normal;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-Oblique.woff2') format('woff2');
        font-weight: normal;
        font-style: italic;
      }
      @font-face {
        font-family: 'DejaVu Sans Mono';
        src: url('/vendor/fonts/dejavu-sans-mono/DejaVuSansMono-BoldOblique.woff2') format('woff2');
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

    // xterm.js (inside ttyd's iframe) measures its own cell/column metrics
    // against whatever font is actually loaded at that moment, which can
    // race ahead of the @font-face fetch above - especially over a real
    // (non-Docker-local) network, where the woff2 fetch can take long
    // enough that tmux's very first attach-redraw (which paints whatever
    // is already in the pane, bold "Welcome back" banner included) lands
    // before the font arrives. That first paint bakes in fallback-font
    // cell metrics into xterm's renderer that persist even after the
    // real font loads - a later same-size resize doesn't fix it, because
    // xterm only remeasures glyph width when the *container* actually
    // changes size or when a font-related terminal option changes; it has
    // no way to know a @font-face it isn't watching just became available.
    // `document.fonts.load(...)` only loads the one weight/style you ask
    // for, so all four (regular/bold/italic/bold-italic) must be listed
    // explicitly or `document.fonts.ready` can resolve without ever having
    // touched the bold/italic faces - they'd then still load lazily,
    // whenever xterm first tries to paint bold/italic text, with nothing
    // to trigger a remeasure afterwards.
    if (doc.fonts) {
      const variants = [
        "16px 'DejaVu Sans Mono'",
        "bold 16px 'DejaVu Sans Mono'",
        "italic 16px 'DejaVu Sans Mono'",
        "italic bold 16px 'DejaVu Sans Mono'",
      ];
      Promise.all(variants.map((v) => doc.fonts.load(v).catch(() => {})))
        .then(() => doc.fonts.ready)
        .then(() => {
          try {
            // ttyd exposes its live xterm.js Terminal instance as
            // `window.term` inside its own iframe document (see its
            // bundled Xterm class: `window.term = t`), contrary to what
            // used to be assumed here. Verified (via a raw CDP network
            // throttle + `document.fonts.check()` poll) that once the
            // real font finishes loading late, xterm's cached cell
            // width/height do NOT get remeasured on their own - confirmed
            // by reading `term._core._renderService.dimensions.css.cell`
            // before/after. Re-assigning `fontFamily` to its *own current
            // value* does nothing either: xterm's OptionsService no-ops
            // same-value writes, so the change handler that would trigger
            // CharSizeService never fires. Toggling to a throwaway value
            // first forces a real change, which does trigger it.
            const term = iframe.contentWindow.term;
            if (term && term.options) {
              const family = term.options.fontFamily;
              term.options.fontFamily = 'monospace';
              term.options.fontFamily = family;
              if (term._core && term._core._charSizeService) {
                term._core._charSizeService.measure();
              }
            }
            // Let ttyd's own window-resize listener (which it does
            // register, despite the name suggesting otherwise) turn the
            // now-correct cell size into new rows/cols and propagate that
            // to the server - reaching in to call fitAddon.fit() directly
            // bypasses that propagation and desyncs the pty's idea of the
            // terminal size from what's on screen.
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

// --- Terminal font size ---
// ttyd reads `fontSize` (and other ITerminalOptions keys) from the iframe
// URL's query string as a per-client override - see parseOptsFromUrlQuery in
// ttyd's bundled frontend. That's the officially supported way to set it;
// there's no other reach-in point since ttyd's Terminal instance isn't
// exposed on the iframe's window.
const FONT_SIZE_KEY = 'claudeweb.terminalFontSize';
const FONT_SIZE_MIN = 10;
const FONT_SIZE_MAX = 28;
const FONT_SIZE_DEFAULT = 16;
const FONT_SIZE_STEP = 2;

function getFontSize() {
  const stored = parseInt(localStorage.getItem(FONT_SIZE_KEY), 10);
  if (Number.isNaN(stored)) return FONT_SIZE_DEFAULT;
  return Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, stored));
}

function terminalUrl(basePath) {
  return `${basePath}?fontSize=${getFontSize()}`;
}

function updateFontSizeDisplay() {
  const size = getFontSize();
  document.getElementById('font-size-value').textContent = size;
  document.getElementById('font-size-dec').disabled = size <= FONT_SIZE_MIN;
  document.getElementById('font-size-inc').disabled = size >= FONT_SIZE_MAX;
}

function setFontSize(size) {
  localStorage.setItem(FONT_SIZE_KEY, String(Math.min(FONT_SIZE_MAX, Math.max(FONT_SIZE_MIN, size))));
  updateFontSizeDisplay();

  // Reload any terminal iframe already pointed at a real session (not
  // about:blank) so the new size takes effect immediately - ttyd's backing
  // tmux session is persistent, so this just reconnects the websocket and
  // redraws, no session/scrollback loss.
  const claudeFrame = document.getElementById('claude-frame');
  if (currentProject && claudeFrame.src) {
    claudeFrame.src = terminalUrl(`/term/${encodeURIComponent(currentProject)}/`);
  }
  const shellFrame = document.getElementById('shell-frame');
  if (shellFrame.dataset.loadedFor) {
    shellFrame.src = terminalUrl(`/shell/${encodeURIComponent(shellFrame.dataset.loadedFor)}/`);
  }
}

document.getElementById('font-size-dec').addEventListener('click', () => setFontSize(getFontSize() - FONT_SIZE_STEP));
document.getElementById('font-size-inc').addEventListener('click', () => setFontSize(getFontSize() + FONT_SIZE_STEP));
updateFontSizeDisplay();

// --- Sidebar resize ---
const SIDEBAR_WIDTH_KEY = 'claudeweb.sidebarWidth';
const SIDEBAR_WIDTH_MIN = 160;
const SIDEBAR_WIDTH_MAX = 480;
const SIDEBAR_WIDTH_DEFAULT = 220;

function getSidebarWidth() {
  const stored = parseInt(localStorage.getItem(SIDEBAR_WIDTH_KEY), 10);
  if (Number.isNaN(stored)) return SIDEBAR_WIDTH_DEFAULT;
  return Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, stored));
}

function setSidebarWidth(width) {
  const clamped = Math.min(SIDEBAR_WIDTH_MAX, Math.max(SIDEBAR_WIDTH_MIN, width));
  document.getElementById('sidebar').style.width = `${clamped}px`;
  return clamped;
}

setSidebarWidth(getSidebarWidth());

const sidebarResizer = document.getElementById('sidebar-resizer');
sidebarResizer.addEventListener('mousedown', (e) => {
  e.preventDefault();
  sidebarResizer.classList.add('dragging');
  document.body.style.cursor = 'col-resize';
  document.body.style.userSelect = 'none';

  const onMouseMove = (moveEvent) => setSidebarWidth(moveEvent.clientX);
  const onMouseUp = (upEvent) => {
    localStorage.setItem(SIDEBAR_WIDTH_KEY, String(setSidebarWidth(upEvent.clientX)));
    sidebarResizer.classList.remove('dragging');
    document.body.style.cursor = '';
    document.body.style.userSelect = '';
    document.removeEventListener('mousemove', onMouseMove);
    document.removeEventListener('mouseup', onMouseUp);
  };
  document.addEventListener('mousemove', onMouseMove);
  document.addEventListener('mouseup', onMouseUp);
});

let currentTab = 'claude';

// Remember which tab was last open per project, so switching back to a
// project restores where you left it instead of wherever the tab bar
// happens to be pointed.
const PROJECT_LAST_TAB_KEY = 'claudeweb.projectLastTab';
let projectLastTab = {};
try {
  projectLastTab = JSON.parse(localStorage.getItem(PROJECT_LAST_TAB_KEY)) || {};
} catch {
  projectLastTab = {};
}

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
  document.getElementById('claude-frame').src = terminalUrl(`/term/${encodeURIComponent(name)}/`);

  // The shell session is started lazily (only once the Terminal tab is
  // actually opened) rather than eagerly like Claude Code's, so switching
  // projects just resets it here; switchTab() re-arms it below if needed.
  const shellFrame = document.getElementById('shell-frame');
  shellFrame.src = 'about:blank';
  delete shellFrame.dataset.loadedFor;

  switchTab(projectLastTab[name] || 'claude');

  await loadFileTree();
  loadProjects(); // refresh running-dot state
}

async function ensureShellStarted() {
  const frame = document.getElementById('shell-frame');
  if (!currentProject || frame.dataset.loadedFor === currentProject) return;
  await fetch(`/api/session/${encodeURIComponent(currentProject)}/start?kind=shell`, { method: 'POST' });
  frame.src = terminalUrl(`/shell/${encodeURIComponent(currentProject)}/`);
  frame.dataset.loadedFor = currentProject;
}

function switchTab(tab) {
  currentTab = tab;
  document.querySelectorAll('.tab-btn').forEach((b) => b.classList.toggle('active', b.dataset.tab === tab));
  document.getElementById('tab-claude').hidden = tab !== 'claude';
  document.getElementById('tab-shell').hidden = tab !== 'shell';
  document.getElementById('tab-files').hidden = tab !== 'files';
  if (tab === 'files') codeMirror.requestMeasure();
  if (tab === 'shell') ensureShellStarted();

  if (currentProject) {
    projectLastTab[currentProject] = tab;
    localStorage.setItem(PROJECT_LAST_TAB_KEY, JSON.stringify(projectLastTab));
  }
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

  codeMirror.setState(createEditorState(data.content, relPath));

  currentRenderer = rendererForPath(relPath);
  document.getElementById('md-toggle').hidden = !currentRenderer;
  setViewMode(currentRenderer ? 'preview' : 'code');
}

document.getElementById('save-btn').addEventListener('click', async () => {
  if (!currentFile) return;
  const content = codeMirror.state.doc.toString();
  const res = await fetch(`/api/file/${encodeURIComponent(currentProject)}`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: currentFile, content }),
  });
  document.getElementById('save-status').textContent = res.ok ? 'Saved' : 'Save failed';
});

document.getElementById('download-btn').addEventListener('click', () => {
  if (!currentFile) return;
  const blob = new Blob([codeMirror.state.doc.toString()], { type: 'text/plain' });
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
