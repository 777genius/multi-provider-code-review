import { readFileSync } from 'fs';
import { resolve } from 'path';
import { extractFindingFingerprint } from '../../../src/github/comment-fingerprint';

type FindingMarkerFixture = {
  readonly schemaVersion: string;
  readonly cases: readonly {
    readonly name: string;
    readonly body: string;
    readonly expectedFingerprint: string | null;
  }[];
};

describe('finding marker grammar golden fixture', () => {
  const fixture = JSON.parse(
    readFileSync(
      resolve(
        process.cwd(),
        'src/review-projection/fixtures/finding-marker-grammar.v1.golden.json'
      ),
      'utf8'
    )
  ) as FindingMarkerFixture;

  it('uses the supported fixture version', () => {
    expect(fixture.schemaVersion).toBe('review_finding_marker_grammar.v1');
  });

  it.each(fixture.cases)('$name', ({ body, expectedFingerprint }) => {
    expect(extractFindingFingerprint(body)).toBe(expectedFingerprint);
  });
});
