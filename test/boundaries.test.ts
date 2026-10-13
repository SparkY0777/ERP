import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { test } from 'node:test';
import ts from 'typescript';

const root = path.resolve('src');
const modules = path.join(root, 'modules');
const compilerOptions: ts.CompilerOptions = {
  module: ts.ModuleKind.NodeNext, moduleResolution: ts.ModuleResolutionKind.NodeNext,
};

function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory() ? files(file) : file.endsWith('.ts') ? [file] : [];
  });
}

function owner(file: string): string | undefined {
  const relative = path.relative(modules, file);
  if (relative.startsWith('..') || path.isAbsolute(relative)) return undefined;
  return relative.split(path.sep)[0];
}

function boundaryError(source: string, target: string): string | undefined {
  const sourceOwner = owner(source);
  const targetOwner = owner(target);
  if (!targetOwner || sourceOwner === targetOwner) return undefined;
  const entry = path.relative(path.join(modules, targetOwner), target);
  if (entry !== 'index.ts' && entry !== 'contracts.ts') return 'Module internals are private';
  if (sourceOwner === 'fees' && (targetOwner !== 'sis' || entry !== 'contracts.ts')) {
    return 'Fees may consume SIS contracts, not its providers';
  }
  if (sourceOwner === 'reporting' && entry !== 'contracts.ts') {
    return 'Reporting reads events, not other module facades';
  }
  if (sourceOwner === 'sis' && targetOwner !== 'fees') return 'SIS only depends on Fees';
  return undefined;
}

test('all source imports and re-exports respect public module boundaries', () => {
  for (const file of files(root)) {
    const source = ts.createSourceFile(file, readFileSync(file, 'utf8'), ts.ScriptTarget.Latest, true);
    function visit(node: ts.Node) {
      let specifier: ts.Expression | undefined;
      if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) specifier = node.moduleSpecifier;
      if (ts.isCallExpression(node) && (
        node.expression.kind === ts.SyntaxKind.ImportKeyword ||
        (ts.isIdentifier(node.expression) && node.expression.text === 'require')
      )) {
        assert.fail(`Use static imports so module boundaries remain inspectable: ${file}`);
      }
      if (specifier && ts.isStringLiteral(specifier) && !isBuiltin(specifier.text)) {
        const resolved = ts.resolveModuleName(specifier.text, file, compilerOptions, ts.sys).resolvedModule;
        assert.ok(resolved, `Unresolved import ${specifier.text} in ${file}`);
        const error = boundaryError(file, resolved.resolvedFileName);
        assert.equal(error, undefined, `${error}: ${file} imports ${specifier.text}`);
      }
      ts.forEachChild(node, visit);
    }
    visit(source);
  }
});

test('boundary rules reject repositories, facade deep imports and reporting service coupling', () => {
  assert.ok(boundaryError(path.join(modules, 'sis/handlers.ts'), path.join(modules, 'fees/handlers.ts')));
  assert.ok(boundaryError(path.join(modules, 'sis/handlers.ts'), path.join(modules, 'fees/facade.ts')));
  assert.ok(boundaryError(path.join(modules, 'reporting/module.ts'), path.join(modules, 'fees/index.ts')));
  assert.ok(boundaryError(path.join(modules, 'fees/handlers.ts'), path.join(modules, 'sis/index.ts')));
  assert.equal(boundaryError(path.join(modules, 'sis/handlers.ts'), path.join(modules, 'fees/index.ts')), undefined);
  assert.equal(boundaryError(path.join(modules, 'fees/handlers.ts'), path.join(modules, 'sis/contracts.ts')), undefined);
});
