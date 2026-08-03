import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { CodexProvider } from '../../src/providers/codex';

const runCodexE2E = process.env.RUN_CODEX_E2E === '1';
const codexE2EModel = process.env.CODEX_E2E_MODEL || 'gpt-5.4-mini';

describe('Codex agentic context e2e', () => {
  (runCodexE2E ? it : it.skip)(
    'reads related files in read-only mode and returns schema-valid JSON',
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-agentic-e2e-'));
      const schemaPath = path.join(dir, 'findings.schema.json');
      const outputPath = path.join(dir, 'codex-output.json');

      fs.mkdirSync(path.join(dir, 'src'));
      fs.writeFileSync(
        path.join(dir, 'src/related.ts'),
        'export const MARKER = "agentic-context-ok";\n'
      );
      fs.writeFileSync(
        path.join(dir, 'src/app.ts'),
        'export const value = 1;\n'
      );
      fs.writeFileSync(
        schemaPath,
        JSON.stringify({
          type: 'object',
          additionalProperties: false,
          required: ['findings'],
          properties: {
            findings: {
              type: 'array',
              items: {
                type: 'object',
                additionalProperties: false,
                required: [
                  'file',
                  'startLine',
                  'line',
                  'endLine',
                  'severity',
                  'title',
                  'message',
                  'suggestion',
                ],
                properties: {
                  file: { type: 'string' },
                  startLine: { type: ['integer', 'null'] },
                  line: { type: 'integer' },
                  endLine: { type: ['integer', 'null'] },
                  severity: {
                    type: 'string',
                    enum: ['critical', 'major', 'minor'],
                  },
                  title: { type: 'string' },
                  message: { type: 'string' },
                  suggestion: { type: ['string', 'null'] },
                },
              },
            },
          },
        })
      );

      spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });

      const result = spawnSync(
        'codex',
        [
          'exec',
          '--model',
          codexE2EModel,
          '--sandbox',
          'read-only',
          '--ephemeral',
          '--ignore-user-config',
          '-c',
          'approval_policy=never',
          '-c',
          'model_reasoning_effort="low"',
          '--json',
          '--output-schema',
          schemaPath,
          '--output-last-message',
          outputPath,
          'Read src/related.ts before answering. Return no findings. Output must match the schema.',
        ],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 120000,
        }
      );

      expect(result.status).toBe(0);

      const output = JSON.parse(fs.readFileSync(outputPath, 'utf8'));
      expect(output).toEqual({ findings: [] });

      const readRelated = result.stdout
        .split(/\r?\n/)
        .filter(Boolean)
        .some((line) => {
          try {
            const event = JSON.parse(line);
            return (
              event?.item?.type === 'command_execution' &&
              String(event.item.command).includes('src/related.ts')
            );
          } catch {
            return false;
          }
        });

      expect(readRelated).toBe(true);
    },
    180_000
  );

  (runCodexE2E ? it : it.skip)(
    'returns non-placeholder JSON through the ReviewRouter prompt-only contract',
    async () => {
      const dir = fs.mkdtempSync(
        path.join(os.tmpdir(), 'codex-prompt-contract-e2e-')
      );
      const previousCwd = process.cwd();

      try {
        spawnSync('git', ['init'], { cwd: dir, encoding: 'utf8' });
        process.chdir(dir);

        const provider = new CodexProvider(codexE2EModel, {
          agenticContext: false,
        });
        const result = await provider.review(
          [
            'Synthetic ReviewRouter schema qualification.',
            'There are no changed files and no lifecycle targets.',
            'Return no findings and no revalidations.',
          ].join('\n'),
          180_000
        );

        expect(result.findings).toEqual([]);
        expect(result.revalidations).toEqual([]);
        expect(result.content).toBe('{"findings":[],"revalidations":[]}');
      } finally {
        process.chdir(previousCwd);
        fs.rmSync(dir, { recursive: true, force: true });
      }
    },
    180_000
  );
});
