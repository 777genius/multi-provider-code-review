import {
  ContextGatewayV4CursorHandles,
  exposeContextGatewayV4Cursor,
} from '../../../src/context-gateway/context-gateway-v4-cursor-handles';

describe('ContextGatewayV4CursorHandles', () => {
  it('keeps signed cursors behind stable short handles', () => {
    const handles = new ContextGatewayV4CursorHandles();
    const signedCursor = 'signed.'.concat('a'.repeat(512));

    const exposed = exposeContextGatewayV4Cursor(
      { complete: false, nextCursor: signedCursor },
      handles
    );

    expect(exposed.nextCursor).toBe('rrc_1');
    expect(handles.resolve(exposed.nextCursor)).toBe(signedCursor);
    expect(handles.expose(signedCursor)).toBe('rrc_1');
  });

  it('uses distinct handles and preserves terminal null cursors', () => {
    const handles = new ContextGatewayV4CursorHandles();

    expect(handles.expose('first')).toBe('rrc_1');
    expect(handles.expose('second')).toBe('rrc_2');
    expect(handles.expose(null)).toBeNull();
    expect(exposeContextGatewayV4Cursor({ nextCursor: null }, handles)).toEqual(
      { nextCursor: null }
    );
  });

  it('rejects malformed or unknown handles before signed cursor validation', () => {
    const handles = new ContextGatewayV4CursorHandles();

    expect(() => handles.resolve('signed.cursor')).toThrow(
      'context_gateway_cursor_handle_invalid'
    );
    expect(() => handles.resolve('rrc_99')).toThrow(
      'context_gateway_cursor_handle_unknown'
    );
  });

  it('rejects malformed gateway responses', () => {
    expect(() =>
      exposeContextGatewayV4Cursor(
        { nextCursor: 42 },
        new ContextGatewayV4CursorHandles()
      )
    ).toThrow('context_gateway_next_cursor_invalid');
  });
});
