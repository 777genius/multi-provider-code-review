import { CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS } from '../../../src/context-gateway/context-gateway-tool-annotations';
import {
  CONTEXT_GATEWAY_TOOL_DEFINITIONS,
  CONTEXT_GATEWAY_V4_TOOL_DEFINITIONS,
} from '../../../src/context-gateway/context-gateway-tool-definitions';

describe('context gateway tool annotations', () => {
  it('declares every confined tool as read-only and closed-world', () => {
    expect(CONTEXT_GATEWAY_TOOL_DEFINITIONS.map((tool) => tool.name)).toEqual([
      'review_read_file',
      'review_list_directory',
      'review_search_text',
      'review_git_fact',
    ]);
    expect(
      CONTEXT_GATEWAY_TOOL_DEFINITIONS.every(
        (tool) =>
          tool.annotations === CONTEXT_GATEWAY_READ_ONLY_TOOL_ANNOTATIONS
      )
    ).toBe(true);
    expect(CONTEXT_GATEWAY_TOOL_DEFINITIONS[0]?.annotations).toEqual({
      readOnlyHint: true,
      destructiveHint: false,
      idempotentHint: true,
      openWorldHint: false,
    });
  });

  it('binds incomplete v4 file reads to contiguous follow-up ranges', () => {
    const readFile = CONTEXT_GATEWAY_V4_TOOL_DEFINITIONS.find(
      (tool) => tool.name === 'review_read_file'
    );

    expect(readFile?.description).toContain('If eof is false');
    expect(readFile?.description).toContain('prior startByte plus byteCount');
    expect(readFile?.description).toContain('until eof is true');
  });

  it('declares a safe optional virtual root for v4 directory listings', () => {
    const listDirectory = CONTEXT_GATEWAY_V4_TOOL_DEFINITIONS.find(
      (tool) => tool.name === 'review_list_directory'
    );
    const schema = listDirectory?.inputSchema as {
      readonly required?: readonly string[];
      readonly properties?: Readonly<Record<string, unknown>>;
    };

    expect(listDirectory?.description).toContain('Omit path or use "."');
    expect(schema.required).toBeUndefined();
    expect(schema.properties?.path).toEqual({
      type: 'string',
      maxLength: 1_024,
    });
  });
});
