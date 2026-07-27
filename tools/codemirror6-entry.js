// Entry point for the vendored CodeMirror 6 bundle. This file is NOT shipped
// to the browser — it's the input to a one-time `npx esbuild` bundle step
// (see the header comment generated into the output file) that produces
// public/vendor/codemirror6/codemirror6.bundle.js, a single self-contained
// ESM file committed to the repo. Re-run the build command in that header
// whenever this entry module changes.

import { EditorState, Compartment } from '@codemirror/state';
import { EditorView, keymap, lineNumbers, drawSelection } from '@codemirror/view';
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands';
import {
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
  StreamLanguage,
} from '@codemirror/language';
import { search, searchKeymap } from '@codemirror/search';
import { tags } from '@lezer/highlight';

import { javascript } from '@codemirror/lang-javascript';
import { json } from '@codemirror/lang-json';
import { css } from '@codemirror/lang-css';
import { html } from '@codemirror/lang-html';
import { xml } from '@codemirror/lang-xml';
import { markdown } from '@codemirror/lang-markdown';
import { python } from '@codemirror/lang-python';
import { yaml } from '@codemirror/lang-yaml';
import { sql } from '@codemirror/lang-sql';
import { cpp } from '@codemirror/lang-cpp';
import { java } from '@codemirror/lang-java';

// No official @codemirror/lang-* package exists for shell, Dockerfile, or
// C# — these are the upstream-maintained ports of the exact CM5 modes this
// project used before (mode/shell, mode/dockerfile, mode/clike's `csharp`
// config), reused via StreamLanguage instead of hand-rewritten, so behavior
// stays byte-for-byte identical to CM5 and picks up upstream fixes.
import { shell } from '@codemirror/legacy-modes/mode/shell';
import { csharp } from '@codemirror/legacy-modes/mode/clike';
import { dockerFile } from '@codemirror/legacy-modes/mode/dockerfile';

export {
  EditorState,
  EditorView,
  Compartment,
  keymap,
  lineNumbers,
  drawSelection,
  defaultKeymap,
  history,
  historyKeymap,
  bracketMatching,
  syntaxHighlighting,
  HighlightStyle,
  search,
  searchKeymap,
  tags,
};

// One factory per MODE_BY_EXT entry in app.js. Wrapped in functions (rather
// than exporting bare LanguageSupport instances) so callers can build fresh
// extension instances on demand and so StreamLanguage.define() only runs
// for the modes actually used.
export const languages = {
  javascript: () => javascript(),
  jsx: () => javascript({ jsx: true }),
  typescript: () => javascript({ typescript: true }),
  tsx: () => javascript({ jsx: true, typescript: true }),
  json: () => json(),
  css: () => css(),
  html: () => html(),
  xml: () => xml(),
  markdown: () => markdown(),
  python: () => python(),
  yaml: () => yaml(),
  sql: () => sql(),
  cpp: () => cpp(),
  java: () => java(),
  shell: () => StreamLanguage.define(shell),
  csharp: () => StreamLanguage.define(csharp),
  dockerfile: () => StreamLanguage.define(dockerFile),
};
