import { readdir, readFile } from 'fs/promises';
import path from 'path';
import ts from 'typescript';

const CONTRACT_ROOTS = Object.freeze([
  path.resolve('src/review-investigation/application'),
  path.resolve('src/review-investigation/domain'),
]);
const FORBIDDEN_LAUNCH_PROPERTIES = new Set([
  'args',
  'command',
  'credentialEnvironment',
  'cwd',
  'executable',
  'providerCredentialEnvironment',
  'runtimeEnvironment',
]);

describe('Review Investigation application boundary', () => {
  it('does not expose process launch, environment, auth-injection, or infrastructure details', async () => {
    const violations: string[] = [];

    for (const filePath of await contractFiles()) {
      const sourceText = await readFile(filePath, 'utf8');
      const sourceFile = ts.createSourceFile(
        filePath,
        sourceText,
        ts.ScriptTarget.Latest,
        true,
        ts.ScriptKind.TS
      );
      inspect(sourceFile, sourceFile, violations);
    }

    expect(violations).toEqual([]);
  });
});

async function contractFiles(): Promise<readonly string[]> {
  const files = await Promise.all(
    CONTRACT_ROOTS.map(async (root) =>
      (await readdir(root, { withFileTypes: true }))
        .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
        .map((entry) => path.join(root, entry.name))
    )
  );
  return files.flat().sort();
}

function inspect(
  node: ts.Node,
  sourceFile: ts.SourceFile,
  violations: string[]
): void {
  if (
    ts.isImportDeclaration(node) &&
    ts.isStringLiteral(node.moduleSpecifier) &&
    /(?:^|\/)infrastructure(?:\/|$)/u.test(node.moduleSpecifier.text)
  ) {
    violations.push(location(sourceFile, node, 'infrastructure import'));
  }
  if (
    ts.isTypeReferenceNode(node) &&
    node.getText(sourceFile) === 'NodeJS.ProcessEnv'
  ) {
    violations.push(location(sourceFile, node, 'NodeJS.ProcessEnv'));
  }
  if (
    (ts.isPropertySignature(node) || ts.isParameter(node)) &&
    node.name &&
    FORBIDDEN_LAUNCH_PROPERTIES.has(propertyName(node.name))
  ) {
    violations.push(
      location(sourceFile, node, `launch property ${propertyName(node.name)}`)
    );
  }
  if (
    ts.isPropertyAccessExpression(node) &&
    node.expression.getText(sourceFile) === 'process'
  ) {
    violations.push(location(sourceFile, node, 'process access'));
  }
  ts.forEachChild(node, (child) => inspect(child, sourceFile, violations));
}

function propertyName(name: ts.PropertyName | ts.BindingName): string {
  return ts.isIdentifier(name) || ts.isStringLiteral(name)
    ? name.text
    : name.getText();
}

function location(
  sourceFile: ts.SourceFile,
  node: ts.Node,
  message: string
): string {
  const { line } = sourceFile.getLineAndCharacterOfPosition(node.getStart());
  return `${path.relative(process.cwd(), sourceFile.fileName)}:${line + 1}:${message}`;
}
