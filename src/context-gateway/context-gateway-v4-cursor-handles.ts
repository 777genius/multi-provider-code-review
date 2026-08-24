const CURSOR_HANDLE_PREFIX = 'rrc_';
const CURSOR_HANDLE_MAX_LENGTH = 64;

export class ContextGatewayV4CursorHandles {
  private readonly cursorsByHandle = new Map<string, string>();
  private readonly handlesByCursor = new Map<string, string>();
  private nextOrdinal = 1;

  expose(cursor: string | null): string | null {
    if (cursor === null) return null;
    const existing = this.handlesByCursor.get(cursor);
    if (existing) return existing;

    const handle = `${CURSOR_HANDLE_PREFIX}${this.nextOrdinal}`;
    this.nextOrdinal += 1;
    this.cursorsByHandle.set(handle, cursor);
    this.handlesByCursor.set(cursor, handle);
    return handle;
  }

  resolve(handle: string | undefined): string | undefined {
    if (handle === undefined) return undefined;
    if (
      !handle.startsWith(CURSOR_HANDLE_PREFIX) ||
      handle.length > CURSOR_HANDLE_MAX_LENGTH
    ) {
      throw new Error('context_gateway_cursor_handle_invalid');
    }
    const cursor = this.cursorsByHandle.get(handle);
    if (!cursor) {
      throw new Error('context_gateway_cursor_handle_unknown');
    }
    return cursor;
  }
}

export function exposeContextGatewayV4Cursor<T>(
  value: T,
  handles: ContextGatewayV4CursorHandles
): T {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value;
  const record = value as Record<string, unknown>;
  if (record.nextCursor !== null && typeof record.nextCursor !== 'string') {
    throw new Error('context_gateway_next_cursor_invalid');
  }
  return {
    ...record,
    nextCursor: handles.expose(record.nextCursor as string | null),
  } as T;
}
