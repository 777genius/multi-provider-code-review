import { SynthesisEngine } from '../../../src/analysis/synthesis';
import { DEFAULT_CONFIG } from '../../../src/config/defaults';
import { Finding, PRContext } from '../../../src/types';

describe('SynthesisEngine', () => {
  const pr: PRContext = {
    number: 1,
    title: 'Test PR',
    body: '',
    author: 'tester',
    draft: false,
    labels: [],
    files: [],
    diff: '',
    additions: 1,
    deletions: 0,
    baseSha: 'base',
    headSha: 'head',
  };

  it('formats inline comments with committable suggestions when available', () => {
    const finding: Finding = {
      file: 'src/users.js',
      line: 10,
      severity: 'critical',
      title: 'SQL injection',
      message: 'Interpolated SQL is unsafe.',
      suggestion:
        "const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [email]);",
    };

    const review = new SynthesisEngine({
      ...DEFAULT_CONFIG,
      inlineMinSeverity: 'minor',
      inlineMaxComments: 5,
    }).synthesize([finding], pr);

    expect(review.inlineComments).toHaveLength(1);
    expect(review.inlineComments[0].severity).toBe('critical');
    expect(review.inlineComments[0].suggestion).toBe(finding.suggestion);
    expect(review.inlineComments[0].body).toContain('_🔴 Critical_');
    expect(review.inlineComments[0].body).toContain('_⚡ Quick win_');
    expect(review.inlineComments[0].body).toContain('**SQL injection**');
    expect(review.inlineComments[0].body).toContain(
      '<summary>Suggested fix</summary>'
    );
    expect(review.inlineComments[0].body).toContain(
      '<summary>📝 Committable suggestion</summary>'
    );
    expect(review.inlineComments[0].body).toContain('```suggestion');
    expect(review.inlineComments[0].body).toContain(finding.suggestion);
    expect(review.inlineComments[0].body).toContain(
      '<summary>🤖 Prompt for AI Agents</summary>'
    );
  });

  it('does not render committable suggestions for multi-line suggestions without a range', () => {
    const finding: Finding = {
      file: 'src/users.js',
      line: 10,
      severity: 'major',
      title: 'Email lookup bypass',
      message: 'The query no longer filters by email.',
      suggestion: [
        'const normalized = normalizeEmail(email);',
        "const rows = await db.query('SELECT * FROM users WHERE email = ? LIMIT 1', [normalized]);",
      ].join('\n'),
    };

    const review = new SynthesisEngine({
      ...DEFAULT_CONFIG,
      inlineMinSeverity: 'minor',
      inlineMaxComments: 5,
    }).synthesize([finding], pr);

    expect(review.inlineComments[0].body).toContain(
      '<summary>Suggested fix</summary>'
    );
    expect(review.inlineComments[0].body).toContain(
      '<summary>🤖 Prompt for AI Agents</summary>'
    );
    expect(review.inlineComments[0].body).not.toContain(
      '<summary>📝 Committable suggestion</summary>'
    );
    expect(review.inlineComments[0].body).not.toContain('```suggestion');
  });

  it('preserves multi-line finding ranges for GitHub review comments', () => {
    const finding: Finding = {
      file: 'src/users.js',
      startLine: 8,
      line: 10,
      endLine: 10,
      severity: 'major',
      title: 'Email lookup bypass',
      message: 'The changed block no longer filters by email.',
    };

    const review = new SynthesisEngine({
      ...DEFAULT_CONFIG,
      inlineMinSeverity: 'minor',
      inlineMaxComments: 5,
    }).synthesize([finding], pr);

    expect(review.inlineComments[0]).toMatchObject({
      path: 'src/users.js',
      startLine: 8,
      line: 10,
      endLine: 10,
    });
  });

  it('renders a clear compact summary for all-clear reviews', () => {
    const review = new SynthesisEngine(
      DEFAULT_CONFIG
    ).synthesizeWithProviderExecutionSummary(
      [],
      {
        ...pr,
        files: [
          {
            filename: 'src/app.ts',
            status: 'modified',
            additions: 1446,
            deletions: 302,
            changes: 1748,
          },
        ],
        additions: 1446,
        deletions: 302,
      },
      {
        planned: 1,
        succeeded: 1,
      }
    );

    expect(review.summary).toContain('## Review complete ✅');
    expect(review.summary).toContain(
      '| Findings | 0 total (critical 0, major 0, minor 0) |'
    );
    expect(review.summary).toContain(
      '| Reviewed diff | 1 files, +1,446 / -302 |'
    );
    expect(review.summary).toContain('| Providers | 1/1 succeeded |');
    expect(review.summary).toContain(
      '<sub>No critical, major, or minor findings were reported for this revision.</sub>'
    );
    expect(review.summary).not.toContain('Review for PR #1');
    expect(review.summary).not.toContain('Providers: 1/1 succeeded');
  });

  it('sorts inline comments by severity before applying the inline limit', () => {
    const findings: Finding[] = [
      {
        file: 'src/minor.ts',
        line: 10,
        severity: 'minor',
        title: 'Minor issue',
        message: 'Small cleanup.',
      },
      {
        file: 'src/critical.ts',
        line: 20,
        severity: 'critical',
        title: 'Critical issue',
        message: 'Unsafe behavior.',
      },
      {
        file: 'src/major.ts',
        line: 30,
        severity: 'major',
        title: 'Major issue',
        message: 'Correctness issue.',
      },
    ];

    const review = new SynthesisEngine({
      ...DEFAULT_CONFIG,
      inlineMinSeverity: 'minor',
      inlineMaxComments: 2,
    }).synthesize(findings, pr);

    expect(review.inlineComments.map((comment) => comment.severity)).toEqual([
      'critical',
      'major',
    ]);
    expect(review.inlineComments[0].body).toContain('_🔴 Critical_');
    expect(review.inlineComments[0].body).toContain('**Critical issue**');
    expect(review.inlineComments[1].body).toContain('_🟡 Major_');
    expect(review.inlineComments[1].body).toContain('**Major issue**');
  });

  it('renders provider model attribution in inline comment footers', () => {
    const review = new SynthesisEngine({
      ...DEFAULT_CONFIG,
      inlineMinSeverity: 'minor',
      inlineMaxComments: 5,
    }).synthesize(
      [
        {
          file: 'auth.js',
          line: 5,
          severity: 'critical',
          title: 'Authentication bypass',
          message: 'Missing email filter.',
          provider: 'openrouter/poolside/laguna-m.1:free',
          providers: ['openrouter/poolside/laguna-m.1:free', 'codex/gpt-5.5'],
          providerModels: [
            {
              provider: 'openrouter/poolside/laguna-m.1:free',
              actualModel: 'poolside/laguna-m.1-20260312:free',
            },
            { provider: 'codex/gpt-5.5' },
          ],
          providerPoolSize: 2,
        },
      ],
      pr
    );

    expect(review.inlineComments[0].body).toContain(
      '<sub>Models: openrouter/poolside/laguna-m.1:free, codex/gpt-5.5 · agreement 2/2</sub>'
    );
    expect(review.inlineComments[0].body).not.toContain(
      'poolside/laguna-m.1-20260312:free'
    );
  });
});
