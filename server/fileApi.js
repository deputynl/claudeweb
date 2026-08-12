const fs = require('fs');
const path = require('path');

const IGNORED = new Set(['node_modules', '.git', 'dist', 'build', '.next', '__pycache__', '.venv']);
const MAX_FILE_BYTES = 2 * 1024 * 1024; // 2MB safety cap for the editor

function safeResolve(projectDir, relPath) {
  const target = path.resolve(projectDir, relPath || '.');
  if (!target.startsWith(path.resolve(projectDir))) {
    throw new Error('path escapes project folder');
  }
  return target;
}

function buildTree(dir, projectDir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
    .filter((e) => !e.name.startsWith('.') && !IGNORED.has(e.name))
    .sort((a, b) => Number(b.isDirectory()) - Number(a.isDirectory()) || a.name.localeCompare(b.name));

  return entries.map((e) => {
    const full = path.join(dir, e.name);
    const rel = path.relative(projectDir, full);
    if (e.isDirectory()) {
      return { name: e.name, path: rel, type: 'dir', children: buildTree(full, projectDir) };
    }
    return { name: e.name, path: rel, type: 'file' };
  });
}

function getTree(projectDir, relPath = '.') {
  const dir = safeResolve(projectDir, relPath);
  return buildTree(dir, projectDir);
}

function readFile(projectDir, relPath) {
  const file = safeResolve(projectDir, relPath);
  const stat = fs.statSync(file);
  if (stat.size > MAX_FILE_BYTES) {
    throw new Error('file too large to display');
  }
  return fs.readFileSync(file, 'utf8');
}

function writeFile(projectDir, relPath, content) {
  const file = safeResolve(projectDir, relPath);
  fs.writeFileSync(file, content, 'utf8');
}

function exists(projectDir, relPath) {
  const file = safeResolve(projectDir, relPath);
  return fs.existsSync(file);
}

// Unlike readFile(), this doesn't decode the file as UTF-8 text (which
// corrupts binary content) or enforce MAX_FILE_BYTES - it just resolves and
// validates the path, and the caller streams the raw bytes from disk.
function resolveForDownload(projectDir, relPath) {
  const file = safeResolve(projectDir, relPath);
  if (!fs.statSync(file).isFile()) {
    throw new Error('not a file');
  }
  return file;
}

module.exports = { getTree, readFile, writeFile, exists, resolveForDownload };
