import { canonicalJson, sha256 } from './context-gateway-contract';
import {
  ContextGatewayV4OperationKind,
  ContextOperationFailureClass,
} from './context-gateway-v4-contract';
import { ContextGatewayV4Recorder } from './context-gateway-v4-recorder';

export async function parseContextGatewayV4Request<T>(input: {
  readonly recorder: ContextGatewayV4Recorder;
  readonly operationKind: ContextGatewayV4OperationKind;
  readonly argumentsValue: unknown;
  readonly parse: (argumentsRecord: Record<string, unknown>) => T;
}): Promise<T> {
  try {
    return input.parse(requireArgumentsRecord(input.argumentsValue));
  } catch (error) {
    await input.recorder.recordRejected({
      operation: {
        kind: input.operationKind,
        argumentShapeHash: sha256(
          canonicalJson(describeShape(input.argumentsValue))
        ),
      },
      failureClass: ContextOperationFailureClass.RecoverableRequest,
      sanitizedReason: 'context_gateway_tool_arguments_invalid',
    });
    throw error;
  }
}

function requireArgumentsRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('context_gateway_tool_arguments_invalid');
  }
  return value as Record<string, unknown>;
}

function describeShape(value: unknown, depth = 0): unknown {
  if (depth >= 4) return 'depth_limit';
  if (value === null) return 'null';
  if (Array.isArray(value)) {
    return {
      kind: 'array',
      length: value.length,
      itemKinds: [...new Set(value.map((item) => primitiveKind(item)))].sort(),
    };
  }
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, describeShape(item, depth + 1)])
    );
  }
  return primitiveKind(value);
}

function primitiveKind(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
