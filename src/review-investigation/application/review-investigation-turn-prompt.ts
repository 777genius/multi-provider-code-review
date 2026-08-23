import type { ReviewInvestigationTurnBrief } from '../domain/investigation-state';
import { canonicalJson, sha256 } from '../domain/canonical-json';

export const REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT =
  'review_investigation_turn_prompt.v3' as const;

const TURN_INSTRUCTIONS = Object.freeze([
  'REVIEW INVESTIGATION TURN CONTRACT:',
  'Use only the reviewrouter Context Gateway tools. Investigate every obligation in the authenticated turn brief.',
  'Every successful Context Gateway result reports operationBudget.remainingOperations. Conclude with the best evidence-backed result before it reaches zero; do not retry after a budget-exceeded response.',
  'For typed search requirements, execute the exact literal query with paths=["."], revision="head", caseSensitive=true, and pageSize=500, then follow every cursor to completion.',
  'For a typed complete_page_chain obligation, put its complete receipt chain in closureClaims only. The control plane derives its discovery evidence; do not duplicate that chain in operationBackedDiscoveryClaims.',
  'For a typed complete_relation_context obligation, rerun its hydrated query and include the complete matching text_search receipt chain plus complete file_read receipts for exactly every requiredPathHashes entry. Never include unrelated search or directory receipts.',
  'During discovery turns, use operationBackedDiscoveryClaims only for additional exploratory text-search chains. Bind each chain to the coverage_contract changed_content obligation that directly motivated the search, copy the exact query passed to the tool, and include every operationReceiptId from the chain.',
  'If an exploratory text search reports context_gateway_relation_path_limit_exceeded, do not claim that rejected search. Narrow the literal query and/or paths until each accepted search covers at most 512 files, or leave the related obligation open when no sound bounded query exists.',
  'Never bind an exploratory search to a deterministic_expansion obligation. If no changed_content source directly motivated it, omit the advisory discovery claim and leave related obligations open.',
  'When inspected evidence reveals additional review scope, add a provider-neutral obligationProposals entry instead of silently broadening an existing obligation.',
  'Each obligation proposal must contain exactly kind, canonicalSubject, canonicalRequirement, and riskPriority. Use only schema-listed kinds; never provide an obligation ID, state, authority decision, or receipt claim.',
  'Obligation proposals are non-authoritative and remain open until the control plane validates and independently closes them with accepted evidence.',
  'Do not close an obligation without complete operation receipt evidence.',
  'Set criticDecision to null during discovery turns. During critic turns, set it to exactly accept, veto, or abstain.',
]);

export const REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT_HASH = sha256(
  canonicalJson({
    contract: REVIEW_INVESTIGATION_TURN_PROMPT_CONTRACT,
    instructions: TURN_INSTRUCTIONS,
    turnBriefEncoding:
      'REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:<canonical-json-base64url>',
    operationBudgetEncoding:
      'REVIEWROUTER_CONTEXT_OPERATION_BUDGET:<positive-integer>',
  })
);

export function buildReviewInvestigationTurnPrompt(input: {
  readonly reviewContextPrompt: string;
  readonly turnBrief: ReviewInvestigationTurnBrief;
  readonly maxGatewayOperations: number;
}): string {
  if (!input.reviewContextPrompt.trim()) {
    throw new Error('review_investigation_context_prompt_missing');
  }
  if (
    !Number.isSafeInteger(input.maxGatewayOperations) ||
    input.maxGatewayOperations < 1
  ) {
    throw new Error('review_investigation_operation_budget_invalid');
  }
  const encodedBrief = Buffer.from(
    canonicalJson(input.turnBrief),
    'utf8'
  ).toString('base64url');
  return [
    input.reviewContextPrompt,
    '',
    ...TURN_INSTRUCTIONS,
    `REVIEWROUTER_CONTEXT_OPERATION_BUDGET:${input.maxGatewayOperations}`,
    `REVIEWROUTER_INVESTIGATION_TURN_BRIEF_V1_BASE64URL:${encodedBrief}`,
  ].join('\n');
}
