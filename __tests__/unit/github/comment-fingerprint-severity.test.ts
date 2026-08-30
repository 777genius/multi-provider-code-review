import { isLikelySameInlineFinding } from '../../../src/github/comment-fingerprint';

describe('inline finding semantic severity safety', () => {
  const major = {
    path: 'src/users.ts',
    line: 12,
    body: [
      '**🟡 Major - SQL injection in account lookup**',
      '',
      'The query interpolates `accountId` directly into SQL, allowing crafted input to alter the WHERE clause.',
    ].join('\n'),
  };
  const critical = {
    path: 'src/users.ts',
    line: 13,
    body: [
      '**🔴 Critical - SQL injection in account lookup**',
      '',
      'The query interpolates `accountId` directly into SQL, allowing crafted input to alter the WHERE clause.',
    ].join('\n'),
  };

  it('does not suppress a newly escalated Critical finding with an older Major', () => {
    expect(isLikelySameInlineFinding(major, critical)).toBe(false);
  });

  it('can reuse an existing Critical thread when a later model downgrades it', () => {
    expect(isLikelySameInlineFinding(critical, major)).toBe(true);
  });

  it('matches semantic duplicates written in Unicode text', () => {
    expect(
      isLikelySameInlineFinding(
        {
          path: 'src/tenant.ts',
          line: 20,
          body: [
            '**🔴 Critical - Утечка данных между арендаторами**',
            '',
            'Проверка арендатора отсутствует, поэтому пользователь может прочитать секретные данные другой организации.',
          ].join('\n'),
        },
        {
          path: 'src/tenant.ts',
          line: 24,
          body: [
            '**🔴 Critical - Данные утекают между арендаторами**',
            '',
            'Без проверки арендатора пользователь может прочитать секретные данные из другой организации.',
          ].join('\n'),
        }
      )
    ).toBe(true);
  });
});
