import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';
import { discoverRustSources } from './rust-source-discovery.mjs';

function fixture(files) {
  const root = resolve('artifacts/testing/aec-iteration/discovery-fixture');
  const sources = new Map(Object.entries(files).map(([file, text]) => [join(root, file), text]));
  const discover = () => discoverRustSources({
    entrypoints: [join(root, 'main.rs')],
    readSource: (file) => sources.get(file),
    fileExists: (file) => sources.has(file),
  });
  return { root, sources, discover };
}

test('discovers aliased #[path] tests through reachable external modules', () => {
  const { root, discover } = fixture({
    'main.rs': 'mod audio;',
    'audio/mod.rs': 'pub(crate) mod lifecycle; mod worker;',
    'audio/lifecycle.rs': '#[cfg(test)] #[path = "lifecycle_tests.rs"] mod tests;',
    'audio/worker.rs': '#[path = "worker_tests.rs"] #[cfg(test)] mod renamed_tests;',
    'audio/lifecycle_tests.rs': '#[test] fn lifecycle() {}',
    'audio/worker_tests.rs': '#[test] fn worker() {}',
    'audio/detached_tests.rs': '#[test] fn detached() {}',
  });
  const wired = discover();
  assert(wired.has(join(root, 'audio/lifecycle_tests.rs')));
  assert(wired.has(join(root, 'audio/worker_tests.rs')));
  assert(!wired.has(join(root, 'audio/detached_tests.rs')));
});

test('nested include paths are relative to their declaring source, not the top owner', () => {
  const { root, discover } = fixture({
    'main.rs': 'mod speech;',
    'speech.rs': 'include!("speech/dispatch.rs"); include!("speech/output.rs");',
    'speech/dispatch.rs': '#[cfg(test)] mod tests { include!("task_tts_dispatch_tests.rs"); }',
    'speech/task_tts_dispatch_tests.rs': '#[test] fn dispatch() {}',
    'speech/output.rs': '#[path = "output/support.rs"] mod support;',
    'speech/output/support.rs': 'fn output() {}',
  });
  const wired = discover();
  assert(wired.has(join(root, 'speech/task_tts_dispatch_tests.rs')));
  assert(wired.has(join(root, 'speech/output/support.rs')));
});

test('default, explicit and inline module directories resolve exact files', () => {
  const { root, discover } = fixture({
    'main.rs': 'mod parent; #[path = "custom"] mod inline { #[path = "aliased.rs"] mod tests; }',
    'parent.rs': 'pub(super) mod child; mod nested { mod leaf; }',
    'parent/child.rs': 'mod grandchild;',
    'parent/child/grandchild.rs': '',
    'parent/nested/leaf.rs': '',
    'custom/aliased.rs': '',
    'parent/leaf.rs': '',
  });
  const wired = discover();
  for (const file of ['parent/child.rs', 'parent/child/grandchild.rs', 'parent/nested/leaf.rs', 'custom/aliased.rs']) {
    assert(wired.has(join(root, file)), file);
  }
  assert(!wired.has(join(root, 'parent/leaf.rs')));
});

test('same basename and declarations in unreachable owners do not create edges', () => {
  const { root, discover } = fixture({
    'main.rs': 'mod actual;',
    'actual.rs': 'mod tests;',
    'actual/tests.rs': '',
    'detached.rs': 'mod tests;',
    'detached/tests.rs': '',
    'tests.rs': '',
  });
  const wired = discover();
  assert(wired.has(join(root, 'actual/tests.rs')));
  assert(!wired.has(join(root, 'detached/tests.rs')));
  assert(!wired.has(join(root, 'tests.rs')));
});

test('comments, nested comments, literals and macro token data are not module edges', () => {
  const { root, discover } = fixture({
    'main.rs': [
      '// mod commented;',
      '/* outer /* mod nested_comment; */ include!("commented.rs"); */',
      'const S: &str = "mod string_payload;";',
      'const RAW: &str = r#"mod raw_payload; include!("commented.rs");"#;',
      'quote! { mod quoted; }',
      'macro_rules! definition { () => { mod macro_payload; } }',
    ].join('\n'),
    ...Object.fromEntries(['commented', 'nested_comment', 'string_payload', 'raw_payload', 'quoted', 'macro_payload'].map((name) => [name + '.rs', ''])),
  });
  assert.deepEqual([...discover()], [join(root, 'main.rs')]);
});

test('repository test chains are recognized, and cutting each real edge makes that test unwired', () => {
  const root = process.cwd();
  const source = join(root, 'apps/desktop/src-tauri/src');
  const entrypoints = [join(source, 'main.rs'), join(source, 'lib.rs')];
  const wired = discoverRustSources({ entrypoints });
  const edges = [
    ['audio/bailian_tasks/lifecycle.rs', /#\[path = "lifecycle_tests.rs"\]\s*mod tests;/, 'audio/bailian_tasks/lifecycle_tests.rs'],
    ['audio/bailian_tasks/worker.rs', /#\[path = "worker_tests.rs"\]\s*mod tests;/, 'audio/bailian_tasks/worker_tests.rs'],
    ['audio/speech/dispatch.rs', /include!\("task_tts_dispatch_tests.rs"\);/, 'audio/speech/task_tts_dispatch_tests.rs'],
    ['provider/gateway_parts/task_tts.rs', /#\[path = "task_tts_tests.rs"\]\s*mod tests;/, 'provider/gateway_parts/task_tts_tests.rs'],
  ];
  for (const [owner, edge, child] of edges) {
    const target = join(source, child);
    assert(wired.has(target), child);
    const text = readFileSync(join(source, owner), 'utf8');
    assert(edge.test(text), owner);
    const cut = discoverRustSources({ entrypoints, readSource: (file) => {
      const content = readFileSync(file, 'utf8');
      return file === join(source, owner) ? content.replace(edge, '') : content;
    } });
    assert(!cut.has(target), 'must flag genuinely disconnected ' + child);
  }
});
