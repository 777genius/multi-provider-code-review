import {
  ReviewInvestigationCurrency,
  type InvestigationReceiptReplayPort,
  type PreparedInvestigationReplay,
  type ReviewInvestigationCurrencyPort,
  type ReviewInvestigationReplayControlPlanePort,
  type ReviewInvestigationReplayUseCasePort,
} from './investigation-control-plane-port';

export class ReplayInvestigationOnRevision implements ReviewInvestigationReplayUseCasePort {
  constructor(
    private readonly dependencies: Readonly<{
      controlPlane: ReviewInvestigationReplayControlPlanePort;
      receipts: InvestigationReceiptReplayPort;
      currency: ReviewInvestigationCurrencyPort;
    }>
  ) {}

  async execute(
    input: Parameters<ReviewInvestigationReplayUseCasePort['execute']>[0]
  ): ReturnType<ReviewInvestigationReplayUseCasePort['execute']> {
    if (!(await this.isCurrent(input))) return null;
    const prepared = await this.dependencies.controlPlane.prepareReplay({
      open: input.open,
      providerManifestCanonicalJson: input.providerManifestCanonicalJson,
      providerManifestHash: input.providerManifestHash,
    });
    if (!prepared || !(await this.isCurrent(input))) return null;

    const replayProofs: Array<{
      obligationId: string;
      replayProofId: string;
    }> = [];
    const proofsByReplayIdentity = new Map<
      string,
      Promise<{ readonly replayProofId: string } | null>
    >();
    for (const obligation of prepared.obligations) {
      if (!(await this.isCurrent(input))) return null;
      const replayIdentity = [
        obligation.contextAttestationId,
        obligation.contextAttestationHash,
        obligation.sourceOperationReceiptIdsHash,
        obligation.replayPlanHash,
      ].join('\0');
      let proof = proofsByReplayIdentity.get(replayIdentity);
      if (!proof) {
        proof = this.replayAndCommit(input, obligation);
        proofsByReplayIdentity.set(replayIdentity, proof);
      }
      const committed = await proof;
      if (committed) {
        replayProofs.push({
          obligationId: obligation.obligationId,
          replayProofId: committed.replayProofId,
        });
      }
    }
    if (!(await this.isCurrent(input))) return null;
    replayProofs.sort((left, right) =>
      compareCodeUnits(left.obligationId, right.obligationId)
    );
    return this.dependencies.controlPlane.replay({
      open: input.open,
      scope: input.scope,
      revision: input.revision,
      prepared,
      replayProofs: Object.freeze(replayProofs),
    });
  }

  private async replayAndCommit(
    input: Parameters<ReviewInvestigationReplayUseCasePort['execute']>[0],
    prepared: PreparedInvestigationReplay['obligations'][number]
  ): Promise<{ readonly replayProofId: string } | null> {
    const replayed = await this.dependencies.receipts.replayReceipt({
      prepared,
      targetRevision: input.revision,
    });
    if (!replayed || !(await this.isCurrent(input))) return null;
    return this.dependencies.controlPlane.commitReceiptReplay({
      open: input.open,
      prepared,
      result: replayed,
    });
  }

  private async isCurrent(
    input: Parameters<ReviewInvestigationReplayUseCasePort['execute']>[0]
  ): Promise<boolean> {
    return (
      (await this.dependencies.currency.check({
        executionId: input.open.executionId,
        workSlotId: input.open.workSlotId,
        reviewRevisionHash: input.open.reviewRevisionHash,
      })) === ReviewInvestigationCurrency.Current
    );
  }
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}
