import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

// Tokenize instead of searching raw text: comments, string payloads and macro
// bodies must not manufacture module edges. Keep string literals for #[path]
// and include!, and preserve braces for inline module directory resolution.
function rustTokens(text) {
  const tokens = [];
  let i = 0;
  while (i < text.length) {
    const tail = text.slice(i);
    if (/^\s/.test(tail)) { i += 1; continue; }
    if (tail.startsWith('//')) {
      const end = text.indexOf('\n', i);
      i = end < 0 ? text.length : end + 1;
      continue;
    }
    if (tail.startsWith('/*')) {
      let depth = 1;
      i += 2;
      while (i < text.length && depth > 0) {
        if (text.startsWith('/*', i)) { depth += 1; i += 2; }
        else if (text.startsWith('*/', i)) { depth -= 1; i += 2; }
        else i += 1;
      }
      continue;
    }
    const raw = tail.match(/^(?:b|c)?r(#+)?"/);
    if (raw) {
      const start = i + raw[0].length;
      const close = '"' + (raw[1] ?? '');
      const end = text.indexOf(close, start);
      tokens.push({ string: text.slice(start, end < 0 ? text.length : end) });
      i = end < 0 ? text.length : end + close.length;
      continue;
    }
    const quoted = tail.match(/^(?:b|c)?"(?:\\.|[^"\\])*"/);
    if (quoted) {
      const value = quoted[0].replace(/^[bc]/, '');
      // Paths in module declarations use ordinary JSON-compatible escapes.
      try { tokens.push({ string: JSON.parse(value) }); }
      catch { tokens.push({ string: null }); }
      i += quoted[0].length;
      continue;
    }
    const character = tail.match(/^(?:b)?'(?:\\.|[^'\\])'/);
    if (character) { i += character[0].length; continue; }
    const identifier = tail.match(/^(?:r#)?[A-Za-z_][A-Za-z0-9_]*/);
    if (identifier) {
      tokens.push(identifier[0].replace(/^r#/, ''));
      i += identifier[0].length;
    } else { tokens.push(text[i]); i += 1; }
  }
  return tokens;
}

function groupEnd(tokens, start) {
  const closes = { '(': ')', '[': ']', '{': '}' };
  const stack = [closes[tokens[start]]];
  for (let i = start + 1; i < tokens.length; i += 1) {
    if (typeof tokens[i] !== 'string') continue;
    if (closes[tokens[i]]) stack.push(closes[tokens[i]]);
    else if (tokens[i] === stack.at(-1)) {
      stack.pop();
      if (stack.length === 0) return i;
    }
  }
  return tokens.length;
}

// Build actual reachable mod/include edges from crate entrypoints. cfg(test)
// modules remain in the graph: discovery is not permission to omit tests.
export function discoverRustSources({ entrypoints, readSource = (file) => readFileSync(file, 'utf8'), fileExists = existsSync }) {
  const wired = new Set();
  const visited = new Set();
  function visit(file, moduleDirectory, pathDirectory) {
    file = resolve(file);
    if (!fileExists(file)) return;
    wired.add(file);
    // An included fragment can be used in more than one module context.
    const key = [file, moduleDirectory, pathDirectory].join('|');
    if (visited.has(key)) return;
    visited.add(key);
    scan(rustTokens(readSource(file)), file, moduleDirectory, pathDirectory);
  }
  function scan(tokens, file, moduleDirectory, pathDirectory) {
    let pathAttribute;
    for (let i = 0; i < tokens.length; i += 1) {
      if (tokens[i] === '#' && tokens[i + 1] === '[') {
        const end = groupEnd(tokens, i + 1);
        if (tokens[i + 2] === 'path' && tokens[i + 3] === '=') {
          pathAttribute = tokens[i + 4]?.string;
        }
        i = end;
        continue;
      }
      if (tokens[i] === 'mod' && typeof tokens[i + 1] === 'string') {
        const name = tokens[i + 1];
        if (tokens[i + 2] === ';') {
          const candidates = typeof pathAttribute === 'string'
            ? [resolve(pathDirectory, pathAttribute)]
            : [join(moduleDirectory, name + '.rs'), join(moduleDirectory, name, 'mod.rs')];
          const child = candidates.find(fileExists);
          if (child) {
            const childDirectory = basename(child) === 'mod.rs'
              ? dirname(child) : join(dirname(child), basename(child, '.rs'));
            visit(child, childDirectory, dirname(child));
          }
          pathAttribute = undefined;
          i += 2;
          continue;
        }
        if (tokens[i + 2] === '{') {
          const end = groupEnd(tokens, i + 2);
          const directory = typeof pathAttribute === 'string'
            ? resolve(pathDirectory, pathAttribute) : join(moduleDirectory, name);
          scan(tokens.slice(i + 3, end), file, directory, directory);
          pathAttribute = undefined;
          i = end;
          continue;
        }
      }
      if (tokens[i] === 'include' && tokens[i + 1] === '!' && tokens[i + 2] === '(') {
        if (typeof tokens[i + 3]?.string === 'string' && tokens[i + 4] === ')') {
          const included = resolve(dirname(file), tokens[i + 3].string);
          visit(included, moduleDirectory, dirname(included));
        }
        i = groupEnd(tokens, i + 2);
        pathAttribute = undefined;
        continue;
      }
      // Other macros contain tokens, not compiled module declarations. Skipping
      // their bodies prevents quote!/json!/macro_rules! data becoming edges.
      if (tokens[i] === 'macro_rules' && tokens[i + 1] === '!' && ['(', '[', '{'].includes(tokens[i + 3])) {
        i = groupEnd(tokens, i + 3);
      } else if (tokens[i] === '!' && ['(', '[', '{'].includes(tokens[i + 1])) {
        i = groupEnd(tokens, i + 1);
      }
      if (tokens[i] === ';' || tokens[i] === '{') pathAttribute = undefined;
    }
  }
  for (const entrypoint of entrypoints) {
    const file = resolve(entrypoint);
    visit(file, dirname(file), dirname(file));
  }
  return wired;
}
