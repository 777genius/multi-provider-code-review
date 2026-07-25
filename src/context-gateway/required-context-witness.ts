export enum RequiredContextWitnessCaptureStatus {
  Captured = 'captured',
  Unavailable = 'unavailable',
}

export interface RequiredContextWitnessGatewayPort {
  gitFact(input: { fact: 'changed_paths' }): Promise<unknown>;
}

export async function captureRequiredContextWitness(
  gateway: RequiredContextWitnessGatewayPort
): Promise<RequiredContextWitnessCaptureStatus> {
  try {
    await gateway.gitFact({ fact: 'changed_paths' });
    return RequiredContextWitnessCaptureStatus.Captured;
  } catch {
    return RequiredContextWitnessCaptureStatus.Unavailable;
  }
}
