import { TextDecoder } from 'util';

const fatalUtf8Decoder = new TextDecoder('utf-8', {
  fatal: true,
  ignoreBOM: true,
});

export type ClassifiedUtf8Content =
  | Readonly<{ kind: 'text'; text: string; lineCount: number }>
  | Readonly<{ kind: 'binary'; text: null; lineCount: null }>;

export function classifyUtf8Content(value: Buffer): ClassifiedUtf8Content {
  if (value.includes(0)) {
    return Object.freeze({ kind: 'binary', text: null, lineCount: null });
  }
  try {
    const text = fatalUtf8Decoder.decode(value);
    return Object.freeze({ kind: 'text', text, lineCount: countLines(text) });
  } catch {
    return Object.freeze({ kind: 'binary', text: null, lineCount: null });
  }
}

function countLines(value: string): number {
  if (value.length === 0) return 0;
  return value.split('\n').length - (value.endsWith('\n') ? 1 : 0);
}
