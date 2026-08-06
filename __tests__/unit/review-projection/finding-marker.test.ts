import {
  FindingMarkerParseKind,
  findingMarkerV2,
  parseFindingMarker,
  stripReservedFindingMarkerSyntax,
} from '../../../src/review-projection/domain/finding-marker';

const FIRST = 'a'.repeat(24);
const SECOND = 'b'.repeat(24);

describe('finding marker grammar', () => {
  it.each(Array.from({ length: 12 }, (_, index) => index + 1))(
    'accepts %i duplicate markers when every marker has the same value',
    (count) => {
      const dialects = [
        `<!-- review-router-finding:${FIRST} -->`,
        `reviewrouter:finding:v2:${FIRST}`,
        `<!-- reviewrouter:finding:v2:${FIRST} -->`,
      ];
      const body = Array.from(
        { length: count },
        (_, index) => dialects[index % dialects.length]
      ).join('\n');

      expect(parseFindingMarker(body)).toEqual({
        kind: FindingMarkerParseKind.Valid,
        fingerprint: FIRST,
      });
    }
  );

  it.each([
    [`<!-- review-router-finding:${FIRST} -->`, SECOND],
    [`reviewrouter:finding:v2:${FIRST}`, SECOND],
    [`<!-- reviewrouter:finding:v2:${FIRST} -->`, SECOND],
  ])('fails closed for mixed marker conflicts', (firstMarker, second) => {
    expect(
      parseFindingMarker(`${firstMarker}\nreviewrouter:finding:v2:${second}`)
    ).toEqual({
      kind: FindingMarkerParseKind.Conflict,
      fingerprints: [FIRST, SECOND],
    });
  });

  it('round-trips a generated lineage marker', () => {
    const lineageId = `rrl_${'a'.repeat(32)}`;

    expect(parseFindingMarker(findingMarkerV2(lineageId))).toEqual({
      kind: FindingMarkerParseKind.Valid,
      fingerprint: lineageId,
    });
  });

  it.each([
    `reviewrouter:finding:v2:${FIRST}_injected`,
    `xreviewrouter:finding:v2:${FIRST}`,
    `https://example/reviewrouter:finding:v2:${FIRST}`,
    `reviewrouter:finding:v2:${'a'.repeat(23)}`,
    '<!-- review-router-finding:not-a-fingerprint -->',
    `REVIEWROUTER:FINDING:V2:${FIRST}`,
  ])('classifies reserved but invalid syntax as malformed', (body) => {
    expect(parseFindingMarker(body)).toEqual({
      kind: FindingMarkerParseKind.Malformed,
    });
  });

  it('removes valid and malformed reserved syntax from model text', () => {
    const sanitized = stripReservedFindingMarkerSyntax(
      [
        'Visible finding.',
        `<!-- review-router-finding:${FIRST} -->`,
        `reviewrouter:finding:v2:${SECOND}_injected`,
      ].join('\n')
    );

    expect(sanitized).toBe('Visible finding.');
    expect(parseFindingMarker(sanitized)).toEqual({
      kind: FindingMarkerParseKind.Absent,
    });
  });
});
