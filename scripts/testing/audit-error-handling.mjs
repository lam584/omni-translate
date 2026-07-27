import fs from 'node:fs';
import path from 'node:path';
import ts from 'typescript';

const root = process.cwd();
const sourceRoot = path.join(root, 'apps', 'desktop', 'src');
const baselinePath = path.join(root, 'scripts', 'testing', 'error-handling-baseline.json');

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(target);
    return /\.(ts|tsx)$/.test(entry.name) && !/\.test\.(ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

function lineOf(source, node) {
  return source.getLineAndCharacterOfPosition(node.getStart(source)).line + 1;
}

function signature(source, file, node, kind) {
  const text = node.getText(source).replace(/\s+/g, ' ').slice(0, 180);
  return `${path.relative(root, file).replaceAll('\\', '/')}:${kind}:${text}`;
}

function isLoggingStatement(statement) {
  const text = statement.getText();
  return /^(?:void\s+)?(?:console\.|append\w*Log\(|diag\w*\(|logger\.)/.test(text);
}

function scanFile(file) {
  const text = fs.readFileSync(file, 'utf8');
  const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, file.endsWith('x') ? ts.ScriptKind.TSX : ts.ScriptKind.TS);
  const findings = [];
  function visit(node) {
    if (ts.isVoidExpression(node) && ts.isCallExpression(node.expression)) {
      const expression = node.expression.getText(source);
      if (!expression.includes('.catch(')) findings.push(signature(source, file, node, 'void-call-without-catch'));
    }
    if (ts.isTryStatement(node)) {
      if (node.finallyBlock && !node.catchClause) findings.push(signature(source, file, node, 'try-finally-without-catch'));
      if (node.catchClause) {
        const statements = node.catchClause.block.statements;
        if (statements.length === 0) findings.push(signature(source, file, node.catchClause, 'empty-catch'));
        else if (statements.every(isLoggingStatement)) findings.push(signature(source, file, node.catchClause, 'log-only-catch'));
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(source);
  return findings;
}

const findings = filesUnder(sourceRoot).flatMap(scanFile).sort();
const baseline = fs.existsSync(baselinePath) ? JSON.parse(fs.readFileSync(baselinePath, 'utf8')) : [];
const baselineSet = new Set(baseline);
const newFindings = findings.filter((item) => !baselineSet.has(item));
const staleBaseline = baseline.filter((item) => !findings.includes(item));

if (process.argv.includes('--print-baseline')) {
  process.stdout.write(`${JSON.stringify(findings, null, 2)}\n`);
  process.exit(0);
}
if (newFindings.length > 0 || staleBaseline.length > 0) {
  if (newFindings.length) console.error(`New unsafe async/error patterns:\n${newFindings.join('\n')}`);
  if (staleBaseline.length) console.error(`Stale baseline entries (remove them):\n${staleBaseline.join('\n')}`);
  process.exit(1);
}
console.log(`Error-handling audit passed (${findings.length} grandfathered findings, no regressions).`);
