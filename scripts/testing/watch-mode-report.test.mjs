// Aggregation entry for the watch-mode report test suite.
//
// package.json `test:watch-mode-report` hard-codes this file path on the
// `node --test` command line, so this file must stay in place. The original
// 1400+ line suite has been split by theme into the modules imported below;
// `node --test` registers tests declared in imported modules, so importing
// them here keeps the single entry point without changing package.json.
//
// Shared fixtures (healthy snapshots, log fragments, classify wrapper) live
// in ./watch-mode-report-test-helpers.mjs.
import './watch-mode-report-route-app.test.mjs';
import './watch-mode-report-environment.test.mjs';
import './watch-mode-report-content.test.mjs';
import './watch-mode-report-provider-io.test.mjs';
