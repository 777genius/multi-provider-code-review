import { canonicalJson, sha256 } from './canonical-json';
import {
  changedPathSemanticRiskPriority,
  REVIEW_INVESTIGATION_RISK_PRIORITY,
} from './semantic-risk-policy';
import { ReviewTurnObligationKind } from './turn-observation';

export const REVIEW_INVESTIGATION_PROBE_PLAN_VERSION =
  'review-investigation-probe-plan.v2' as const;
export const REVIEW_INVESTIGATION_PROBE_POLICY_VERSION =
  'review-investigation-probe-policy.v3' as const;
export const REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION =
  'review-investigation-fixed-string-search.v1' as const;

export const REVIEW_INVESTIGATION_PROBE_LIMITS = Object.freeze({
  maxProbesPerFile: 48,
  maxProbesOverall: 384,
});
export const REVIEW_INVESTIGATION_MIN_IDENTIFIER_PROBE_LENGTH = 4;
export const REVIEW_INVESTIGATION_GENERIC_PROBE_DENYLIST = Object.freeze([
  'app',
  'api',
  'broadcast',
  'cache',
  'caches',
  'channel',
  'channels',
  'commit',
  'config',
  'configuration',
  'create',
  'data',
  'default',
  'delete',
  'dequeue',
  'destroy',
  'dispatch',
  'emit',
  'enqueue',
  'endpoint',
  'endpoints',
  'error',
  'event',
  'events',
  'evict',
  'false',
  'feature',
  'features',
  'fetch',
  'flag',
  'flags',
  'get',
  'handler',
  'id',
  'ids',
  'index',
  'insert',
  'invalidate',
  'item',
  'items',
  'key',
  'keys',
  'load',
  'main',
  'name',
  'notify',
  'null',
  'options',
  'patch',
  'permission',
  'permissions',
  'publish',
  'queue',
  'queues',
  'read',
  'remove',
  'request',
  'required',
  'response',
  'result',
  'rollback',
  'route',
  'routes',
  'router',
  'routers',
  'save',
  'scope',
  'scopes',
  'send',
  'service',
  'set',
  'status',
  'topic',
  'topics',
  'true',
  'type',
  'undefined',
  'update',
  'upsert',
  'value',
  'values',
  'webhook',
  'webhooks',
  'write',
]);
export const REVIEW_INVESTIGATION_GENERIC_AUTHORIZATION_PROBE_DENYLIST =
  Object.freeze(['member', 'owner', 'role', 'roles']);

export enum ReviewInvestigationChangedFileStatus {
  Added = 'added',
  Modified = 'modified',
  Removed = 'removed',
  Renamed = 'renamed',
}

export enum ReviewInvestigationProbeKind {
  DeclarationIdentifier = 'declaration_identifier',
  ImportExportIdentifier = 'import_export_identifier',
  ModulePath = 'module_path',
  StructuredKey = 'structured_key',
  RuntimeContractIdentifier = 'runtime_contract_identifier',
  SideEffectIdentifier = 'side_effect_identifier',
  PreviousPath = 'previous_path',
  BasenameFallback = 'basename_fallback',
}

export enum ReviewInvestigationProbePlanStatus {
  Complete = 'complete',
  LimitExceeded = 'limit_exceeded',
}

export enum ReviewInvestigationProbeLimitKind {
  PerFile = 'per_file',
  Overall = 'overall',
}

export type ReviewInvestigationProbeLimits = Readonly<{
  maxProbesPerFile: number;
  maxProbesOverall: number;
}>;

export type ReviewInvestigationChangedFileFact = Readonly<{
  path: string;
  previousPath: string | null;
  status: ReviewInvestigationChangedFileStatus;
  patch: string | null;
}>;

export type ReviewInvestigationChangedPathFact = Readonly<{
  path: string;
  previousPath: string | null;
  status: ReviewInvestigationChangedFileStatus;
}>;

export type ReviewInvestigationContextProbe = Readonly<{
  probeKind: ReviewInvestigationProbeKind;
  obligationKind: ReviewTurnObligationKind;
  query: string;
  queryHash: string;
  sourcePath: string;
  sourcePathHash: string;
  initialOperationInputHash: string;
  canonicalSubject: string;
  canonicalRequirement: string;
  riskPriority: number;
}>;

type ReviewInvestigationProbePlanBase = Readonly<{
  planVersion: typeof REVIEW_INVESTIGATION_PROBE_PLAN_VERSION;
  policyVersion: typeof REVIEW_INVESTIGATION_PROBE_POLICY_VERSION;
  searchPolicyVersion: typeof REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION;
  limits: ReviewInvestigationProbeLimits;
  changedPaths: readonly ReviewInvestigationChangedPathFact[];
  planHash: string;
}>;

export const REVIEW_INVESTIGATION_PROBE_SELECTION_POLICY_VERSION =
  'review-investigation-risk-ranked-selection.v1' as const;

export type ReviewInvestigationProbeSelectionWitness = Readonly<{
  policyVersion: typeof REVIEW_INVESTIGATION_PROBE_SELECTION_POLICY_VERSION;
  perFileTruncations: readonly Readonly<{
    sourcePathHash: string;
    maximum: number;
    discardedCandidateOccurrences: number;
  }>[];
  overallTruncation: Readonly<{
    maximum: number;
    discardedCandidateOccurrences: number;
  }> | null;
}>;

export type CompleteReviewInvestigationProbePlan =
  ReviewInvestigationProbePlanBase &
    Readonly<{
      status: ReviewInvestigationProbePlanStatus.Complete;
      probes: readonly ReviewInvestigationContextProbe[];
      exceededLimit: null;
      selectionWitness: ReviewInvestigationProbeSelectionWitness;
    }>;

export type IncompleteReviewInvestigationProbePlan =
  ReviewInvestigationProbePlanBase &
    Readonly<{
      status: ReviewInvestigationProbePlanStatus.LimitExceeded;
      probes: readonly [];
      exceededLimit: Readonly<{
        kind: ReviewInvestigationProbeLimitKind;
        maximum: number;
        observedCount: number;
        sourcePath: string | null;
        sourcePathHash: string | null;
      }>;
      selectionWitness: null;
    }>;

export type ReviewInvestigationProbePlan =
  | CompleteReviewInvestigationProbePlan
  | IncompleteReviewInvestigationProbePlan;

type ProbeCandidate = Readonly<{
  probeKind: ReviewInvestigationProbeKind;
  query: string;
  sourcePath: string;
  riskPriority: number;
}>;

const GENERIC_PROBE_QUERIES = new Set(
  REVIEW_INVESTIGATION_GENERIC_PROBE_DENYLIST
);
const GENERIC_AUTHORIZATION_PROBE_QUERIES = new Set(
  REVIEW_INVESTIGATION_GENERIC_AUTHORIZATION_PROBE_DENYLIST
);

const PROBE_KIND_PRIORITY: Readonly<
  Record<ReviewInvestigationProbeKind, number>
> = Object.freeze({
  [ReviewInvestigationProbeKind.SideEffectIdentifier]: 0,
  [ReviewInvestigationProbeKind.RuntimeContractIdentifier]: 1,
  [ReviewInvestigationProbeKind.StructuredKey]: 2,
  [ReviewInvestigationProbeKind.DeclarationIdentifier]: 3,
  [ReviewInvestigationProbeKind.ImportExportIdentifier]: 4,
  [ReviewInvestigationProbeKind.ModulePath]: 5,
  [ReviewInvestigationProbeKind.PreviousPath]: 6,
  [ReviewInvestigationProbeKind.BasenameFallback]: 7,
});

const STRUCTURED_PATH_PATTERN =
  /(?:^|\/)(?:config|configs|configuration|schema|schemas|migration|migrations)(?:\/|$)|\.(?:json|ya?ml|toml|ini|graphql|gql|proto|prisma|sql)$/iu;
const RUNTIME_CONTRACT_KEYWORD_PATTERN =
  /route|router|endpoint|event|topic|permission|role|scope|cache|feature|flag|queue|channel|webhook/iu;
const RUNTIME_CONTRACT_IDENTIFIER_PATTERN =
  /route|endpoint|event|topic|permission|role|scope|cache|feature|flag|queue|channel|webhook/iu;
const SIDE_EFFECT_NAME_PATTERN =
  /^(?:create|read|load|fetch|get|update|patch|delete|remove|destroy|insert|upsert|save|write|publish|emit|dispatch|broadcast|invalidate|evict|send|notify|enqueue|dequeue|commit|rollback)(?:$|[A-Z0-9_$-])/u;
const ROUTE_CALL_PATTERN =
  /(?:\brouter\b|\broute\b|\bapp\b|\.(?:get|post|put|patch|delete|options|head)\s*\()/iu;

export function createReviewInvestigationProbePlan(input: {
  readonly files: readonly ReviewInvestigationChangedFileFact[];
  readonly fullDiff: string;
  readonly limits?: ReviewInvestigationProbeLimits;
}): ReviewInvestigationProbePlan {
  const limits = normalizeLimits(
    input.limits ?? REVIEW_INVESTIGATION_PROBE_LIMITS
  );
  const diffByPath = splitDiffByDestinationPath(input.fullDiff);
  const files = [...input.files].sort(compareFileFacts);
  assertUniquePaths(files);
  const changedPaths = Object.freeze(
    files.map((file) =>
      Object.freeze({
        path: file.path,
        previousPath: file.previousPath,
        status: file.status,
      })
    )
  );

  const globalCandidates = new Map<string, ProbeCandidate>();
  const perFileTruncations: Array<{
    sourcePathHash: string;
    maximum: number;
    discardedCandidateOccurrences: number;
  }> = [];
  let overallDiscardedCandidateOccurrences = 0;
  for (const file of files) {
    assertPath(file.path, 'review_investigation_probe_path_invalid');
    if (file.previousPath !== null) {
      assertPath(
        file.previousPath,
        'review_investigation_probe_previous_path_invalid'
      );
    }
    const fileCandidates = new Map<string, ProbeCandidate>();
    let discardedCandidateOccurrences = 0;
    const add = (probeKind: ReviewInvestigationProbeKind, query: string) => {
      const normalized = normalizeQuery(query);
      if (normalized === null || !isSpecificProbeQuery(probeKind, normalized)) {
        return;
      }
      const candidate = Object.freeze({
        probeKind,
        query: normalized,
        sourcePath: file.path,
        riskPriority: candidateRiskPriority(probeKind, file.path),
      });
      if (
        upsertBoundedCandidate(
          fileCandidates,
          candidate,
          limits.maxProbesPerFile
        )
      ) {
        discardedCandidateOccurrences += 1;
      }
    };

    add(
      ReviewInvestigationProbeKind.BasenameFallback,
      reviewInvestigationBasenameFallbackQuery(file.path)
    );
    if (
      file.status === ReviewInvestigationChangedFileStatus.Removed ||
      file.status === ReviewInvestigationChangedFileStatus.Renamed
    ) {
      const previousPath = file.previousPath ?? file.path;
      add(ReviewInvestigationProbeKind.PreviousPath, previousPath);
      add(
        ReviewInvestigationProbeKind.BasenameFallback,
        reviewInvestigationBasenameFallbackQuery(previousPath)
      );
    }

    const patch = diffByPath.get(file.path) ?? file.patch ?? '';
    for (const line of changedLines(patch)) {
      extractDeclarationIdentifiers(line, add);
      extractImportExportRelations(line, add);
      extractStructuredRelations(file.path, line, add);
      extractRuntimeContractRelations(line, add);
      extractSideEffectRelations(line, add);
    }
    if (discardedCandidateOccurrences > 0) {
      perFileTruncations.push({
        sourcePathHash: sha256(file.path),
        maximum: limits.maxProbesPerFile,
        discardedCandidateOccurrences,
      });
    }
    for (const candidate of fileCandidates.values()) {
      if (
        upsertBoundedCandidate(
          globalCandidates,
          candidate,
          limits.maxProbesOverall
        )
      ) {
        overallDiscardedCandidateOccurrences += 1;
      }
    }
  }

  const probes = Object.freeze(
    [...globalCandidates.values()].map(createProbe).sort(compareProbes)
  );
  const payload = Object.freeze({
    planVersion: REVIEW_INVESTIGATION_PROBE_PLAN_VERSION,
    policyVersion: REVIEW_INVESTIGATION_PROBE_POLICY_VERSION,
    searchPolicyVersion: REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
    status: ReviewInvestigationProbePlanStatus.Complete,
    limits,
    changedPaths,
    probes,
    exceededLimit: null,
    selectionWitness: Object.freeze({
      policyVersion: REVIEW_INVESTIGATION_PROBE_SELECTION_POLICY_VERSION,
      perFileTruncations: Object.freeze(
        perFileTruncations
          .sort((left, right) =>
            compareCodeUnits(left.sourcePathHash, right.sourcePathHash)
          )
          .map((item) => Object.freeze(item))
      ),
      overallTruncation:
        overallDiscardedCandidateOccurrences === 0
          ? null
          : Object.freeze({
              maximum: limits.maxProbesOverall,
              discardedCandidateOccurrences:
                overallDiscardedCandidateOccurrences,
            }),
    }),
  });
  return Object.freeze({
    ...payload,
    planHash: sha256(canonicalJson(payload)),
  });
}

export function reviewInvestigationSearchOperationInputHash(
  query: string
): string {
  const normalized = normalizeQuery(query);
  if (normalized === null || normalized !== query) {
    throw new Error('review_investigation_probe_query_invalid');
  }
  return sha256(
    canonicalJson({
      caseSensitive: true,
      cursor: null,
      pageSize: 500,
      paths: ['.'],
      query: sha256(query),
      revision: 'head',
    })
  );
}

export function reviewInvestigationBasenameFallbackQuery(path: string): string {
  assertPath(path, 'review_investigation_probe_path_invalid');
  const basename = basenameWithoutExtension(path);
  return isSpecificProbeQuery(
    ReviewInvestigationProbeKind.BasenameFallback,
    basename
  )
    ? basename
    : path;
}

function createProbe(
  candidate: ProbeCandidate
): ReviewInvestigationContextProbe {
  const obligationKind = obligationKindFor(candidate);
  const queryHash = sha256(candidate.query);
  const sourcePathHash = sha256(candidate.sourcePath);
  const initialOperationInputHash = reviewInvestigationSearchOperationInputHash(
    candidate.query
  );
  const canonicalSubject = canonicalJson({
    initialOperationInputHash,
    kind: 'text_search',
    matchMode: 'fixed_string',
    obligationKind,
    probeKind: candidate.probeKind,
    queryHash,
    subjectVersion: 1,
  });
  const canonicalRequirement = canonicalJson({
    initialOperationInputHash,
    kind: 'complete_page_chain',
    matchMode: 'fixed_string',
    operationKind: 'text_search',
    pageSize: 500,
    paths: ['.'],
    probeKind: candidate.probeKind,
    query: candidate.query,
    queryHash,
    requirementVersion: 2,
    revision: 'head',
    searchPolicyVersion: REVIEW_INVESTIGATION_SEARCH_POLICY_VERSION,
    sourcePathHash,
  });
  return Object.freeze({
    probeKind: candidate.probeKind,
    obligationKind,
    query: candidate.query,
    queryHash,
    sourcePath: candidate.sourcePath,
    sourcePathHash,
    initialOperationInputHash,
    canonicalSubject,
    canonicalRequirement,
    riskPriority: candidate.riskPriority,
  });
}

function extractDeclarationIdentifiers(
  line: string,
  add: (kind: ReviewInvestigationProbeKind, query: string) => void
): void {
  const declarations = [
    /\b(?:export\s+(?:default\s+)?)?(?:declare\s+)?(?:async\s+)?(?:function|class|interface|type|enum|namespace|const|let|var|struct|trait|record)\s+([A-Za-z_$][A-Za-z0-9_$]*)/gu,
    /\b(?:async\s+)?def\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
    /\b(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+([A-Za-z_][A-Za-z0-9_]*)/gu,
    /\bfunc\s+(?:\([^)]*\)\s*)?([A-Za-z_][A-Za-z0-9_]*)/gu,
    /\b(?:exports|module\.exports)\.([A-Za-z_$][A-Za-z0-9_$]*)/gu,
    /\b(?:public|protected)\s+(?:(?:static|async|final|abstract|override|readonly)\s+)*(?:[A-Za-z_$][A-Za-z0-9_$<>,.?]*(?:\[\])?\s+)?([A-Za-z_$][A-Za-z0-9_$]*)\s*(?:<[^>\n]*>)?\s*\(/gu,
  ];
  for (const pattern of declarations) {
    for (const match of line.matchAll(pattern)) {
      add(ReviewInvestigationProbeKind.DeclarationIdentifier, match[1]!);
    }
  }
}

function extractImportExportRelations(
  line: string,
  add: (kind: ReviewInvestigationProbeKind, query: string) => void
): void {
  if (!/\b(?:import|export|require|include|use)\b/u.test(line)) return;

  const modulePatterns = [
    /\bfrom\s*["'`]([^"'`\r\n]+)["'`]/gu,
    /\b(?:require|import)\s*\(\s*["'`]([^"'`\r\n]+)["'`]/gu,
    /\b(?:import|include)\s*["'`]([^"'`\r\n]+)["'`]/gu,
    /\buse\s+([A-Za-z_][A-Za-z0-9_:]*)/gu,
  ];
  for (const pattern of modulePatterns) {
    for (const match of line.matchAll(pattern)) {
      add(ReviewInvestigationProbeKind.ModulePath, match[1]!);
    }
  }

  for (const match of line.matchAll(/\{([^{}]+)\}/gu)) {
    for (const item of match[1]!.split(',')) {
      const names = item
        .trim()
        .replace(/^type\s+/u, '')
        .split(/\s+as\s+/u)
        .map((value) => value.trim());
      for (const name of names) {
        if (/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(name)) {
          add(ReviewInvestigationProbeKind.ImportExportIdentifier, name);
        }
      }
    }
  }
}

function extractStructuredRelations(
  path: string,
  line: string,
  add: (kind: ReviewInvestigationProbeKind, query: string) => void
): void {
  const keyPatterns = [
    /(?:^|[{,])\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*:/gu,
    /^\s*-?\s*["']?([A-Za-z_][A-Za-z0-9_.-]*)["']?\s*=/gu,
    /\b(?:ADD|DROP|RENAME)\s+(?:COLUMN\s+)?["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?/giu,
    /\b(?:CREATE|ALTER)\s+TABLE\s+["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?/giu,
    /\bREFERENCES\s+["`]?([A-Za-z_][A-Za-z0-9_$]*)["`]?/giu,
  ];
  for (const pattern of keyPatterns) {
    for (const match of line.matchAll(pattern)) {
      add(ReviewInvestigationProbeKind.StructuredKey, match[1]!);
    }
  }
  if (STRUCTURED_PATH_PATTERN.test(path)) {
    for (const literal of quotedLiterals(line)) {
      if (isContractLiteral(literal)) {
        add(ReviewInvestigationProbeKind.StructuredKey, literal);
      }
    }
  }
}

function extractRuntimeContractRelations(
  line: string,
  add: (kind: ReviewInvestigationProbeKind, query: string) => void
): void {
  const isRuntimeLine = RUNTIME_CONTRACT_KEYWORD_PATTERN.test(line);
  const isRouteCall = ROUTE_CALL_PATTERN.test(line);
  if (!isRuntimeLine && !isRouteCall) return;

  for (const match of line.matchAll(/[A-Za-z_$][A-Za-z0-9_$]*/gu)) {
    if (RUNTIME_CONTRACT_IDENTIFIER_PATTERN.test(match[0])) {
      add(ReviewInvestigationProbeKind.RuntimeContractIdentifier, match[0]);
    }
  }
  for (const literal of quotedLiterals(line)) {
    if (
      isContractLiteral(literal) ||
      (isRouteCall && literal.startsWith('/'))
    ) {
      add(ReviewInvestigationProbeKind.RuntimeContractIdentifier, literal);
    }
  }
}

function extractSideEffectRelations(
  line: string,
  add: (kind: ReviewInvestigationProbeKind, query: string) => void
): void {
  let found = false;
  for (const match of line.matchAll(
    /\b(?:[A-Za-z_$][A-Za-z0-9_$]*\.)*([A-Za-z_$][A-Za-z0-9_$]*)\s*\(/gu
  )) {
    if (SIDE_EFFECT_NAME_PATTERN.test(match[1]!)) {
      found = true;
      add(ReviewInvestigationProbeKind.SideEffectIdentifier, match[1]!);
    }
  }
  if (!found) return;
  for (const literal of quotedLiterals(line)) {
    if (isContractLiteral(literal)) {
      add(ReviewInvestigationProbeKind.SideEffectIdentifier, literal);
    }
  }
}

function obligationKindFor(
  candidate: ProbeCandidate
): ReviewTurnObligationKind {
  switch (candidate.probeKind) {
    case ReviewInvestigationProbeKind.StructuredKey:
      return STRUCTURED_PATH_PATTERN.test(candidate.sourcePath) &&
        /(?:^|\/)(?:config|configs|configuration)(?:\/|$)|\.(?:ya?ml|toml|ini)$/iu.test(
          candidate.sourcePath
        )
        ? ReviewTurnObligationKind.ConfigurationContract
        : ReviewTurnObligationKind.SchemaContract;
    case ReviewInvestigationProbeKind.RuntimeContractIdentifier:
      return ReviewTurnObligationKind.ConfigurationContract;
    case ReviewInvestigationProbeKind.SideEffectIdentifier:
      return ReviewTurnObligationKind.SideEffectParity;
    case ReviewInvestigationProbeKind.DeclarationIdentifier:
    case ReviewInvestigationProbeKind.ImportExportIdentifier:
    case ReviewInvestigationProbeKind.ModulePath:
    case ReviewInvestigationProbeKind.PreviousPath:
    case ReviewInvestigationProbeKind.BasenameFallback:
      return ReviewTurnObligationKind.DirectReferenceSearch;
  }
}

function candidateRiskPriority(
  probeKind: ReviewInvestigationProbeKind,
  sourcePath: string
): number {
  switch (probeKind) {
    case ReviewInvestigationProbeKind.StructuredKey:
    case ReviewInvestigationProbeKind.RuntimeContractIdentifier:
    case ReviewInvestigationProbeKind.SideEffectIdentifier:
      return REVIEW_INVESTIGATION_RISK_PRIORITY.HighRiskChangedPath;
    case ReviewInvestigationProbeKind.DeclarationIdentifier:
    case ReviewInvestigationProbeKind.ImportExportIdentifier:
    case ReviewInvestigationProbeKind.ModulePath:
    case ReviewInvestigationProbeKind.PreviousPath:
    case ReviewInvestigationProbeKind.BasenameFallback:
      return changedPathSemanticRiskPriority(sourcePath);
  }
}

function quotedLiterals(line: string): readonly string[] {
  return [...line.matchAll(/["'`]([^"'`\r\n]{1,256})["'`]/gu)].map(
    (match) => match[1]!
  );
}

function isContractLiteral(value: string): boolean {
  return (
    value.length <= 256 && /[\p{L}\p{N}]/u.test(value) && !/\s/u.test(value)
  );
}

function changedLines(patch: string): readonly string[] {
  return patch
    .split(/\r?\n/u)
    .filter(
      (line) =>
        (line.startsWith('+') && !line.startsWith('+++')) ||
        (line.startsWith('-') && !line.startsWith('---'))
    )
    .map((line) => line.slice(1));
}

function splitDiffByDestinationPath(diff: string): ReadonlyMap<string, string> {
  const chunks = new Map<string, string>();
  const matches = [...diff.matchAll(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/gmu)];
  for (let index = 0; index < matches.length; index += 1) {
    const match = matches[index]!;
    if (match.index === undefined) continue;
    const path = unquoteGitPath(match[2]!.trim());
    const end = matches[index + 1]?.index ?? diff.length;
    if (path.length === 0 || chunks.has(path)) continue;
    chunks.set(path, diff.slice(match.index, end));
  }
  return chunks;
}

function unquoteGitPath(value: string): string {
  const path =
    value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
  return path.replace(/\\([\\"tnr])/gu, (_match, char: string) => {
    if (char === 't') return '\t';
    if (char === 'n') return '\n';
    if (char === 'r') return '\r';
    return char;
  });
}

function basenameWithoutExtension(path: string): string {
  const fileName = path.split('/').at(-1) ?? path;
  const extension = fileName.lastIndexOf('.');
  return extension > 0 ? fileName.slice(0, extension) : fileName;
}

function normalizeQuery(value: string): string | null {
  const query = value.trim();
  if (
    query.length === 0 ||
    query.length > 1_024 ||
    [...query].some((character) => {
      const codePoint = character.codePointAt(0);
      return (
        codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)
      );
    })
  ) {
    return null;
  }
  return query;
}

function isSpecificProbeQuery(
  probeKind: ReviewInvestigationProbeKind,
  query: string
): boolean {
  const normalizedQuery = query.toLowerCase();
  if (GENERIC_PROBE_QUERIES.has(normalizedQuery)) return false;
  if (
    probeKind === ReviewInvestigationProbeKind.RuntimeContractIdentifier &&
    GENERIC_AUTHORIZATION_PROBE_QUERIES.has(normalizedQuery)
  ) {
    return false;
  }
  if (/^\d+$/u.test(query)) return query.length >= 8;
  if (!/^[A-Za-z_$][A-Za-z0-9_$]*$/u.test(query)) {
    return query.length >= 2;
  }
  if (
    probeKind === ReviewInvestigationProbeKind.PreviousPath ||
    probeKind === ReviewInvestigationProbeKind.BasenameFallback
  ) {
    return query.length >= REVIEW_INVESTIGATION_MIN_IDENTIFIER_PROBE_LENGTH;
  }
  return (
    query.length >= REVIEW_INVESTIGATION_MIN_IDENTIFIER_PROBE_LENGTH ||
    (query.length >= 3 && /[A-Z]/u.test(query))
  );
}

function upsertBoundedCandidate(
  candidates: Map<string, ProbeCandidate>,
  candidate: ProbeCandidate,
  maximum: number
): boolean {
  const existing = candidates.get(candidate.query);
  if (existing) {
    if (compareCandidates(candidate, existing) < 0) {
      candidates.set(candidate.query, candidate);
    }
    return false;
  }
  if (candidates.size < maximum) {
    candidates.set(candidate.query, candidate);
    return false;
  }

  let worst: ProbeCandidate | undefined;
  for (const retained of candidates.values()) {
    if (!worst || compareCandidates(retained, worst) > 0) worst = retained;
  }
  if (worst && compareCandidates(candidate, worst) < 0) {
    candidates.delete(worst.query);
    candidates.set(candidate.query, candidate);
  }
  return true;
}

function compareCandidates(
  left: ProbeCandidate,
  right: ProbeCandidate
): number {
  return (
    right.riskPriority - left.riskPriority ||
    compareCodeUnits(left.sourcePath, right.sourcePath) ||
    PROBE_KIND_PRIORITY[left.probeKind] -
      PROBE_KIND_PRIORITY[right.probeKind] ||
    compareCodeUnits(left.query, right.query)
  );
}

function compareProbes(
  left: ReviewInvestigationContextProbe,
  right: ReviewInvestigationContextProbe
): number {
  return (
    compareCodeUnits(left.query, right.query) ||
    compareCodeUnits(left.obligationKind, right.obligationKind) ||
    compareCodeUnits(left.probeKind, right.probeKind) ||
    compareCodeUnits(left.sourcePath, right.sourcePath)
  );
}

function compareFileFacts(
  left: ReviewInvestigationChangedFileFact,
  right: ReviewInvestigationChangedFileFact
): number {
  return (
    compareCodeUnits(left.path, right.path) ||
    compareCodeUnits(left.previousPath ?? '', right.previousPath ?? '') ||
    compareCodeUnits(left.status, right.status)
  );
}

function compareCodeUnits(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function normalizeLimits(
  limits: ReviewInvestigationProbeLimits
): ReviewInvestigationProbeLimits {
  if (
    !Number.isSafeInteger(limits.maxProbesPerFile) ||
    limits.maxProbesPerFile < 1 ||
    !Number.isSafeInteger(limits.maxProbesOverall) ||
    limits.maxProbesOverall < limits.maxProbesPerFile
  ) {
    throw new Error('review_investigation_probe_limits_invalid');
  }
  return Object.freeze({
    maxProbesPerFile: limits.maxProbesPerFile,
    maxProbesOverall: limits.maxProbesOverall,
  });
}

function assertUniquePaths(
  files: readonly ReviewInvestigationChangedFileFact[]
): void {
  const paths = files.map((file) => file.path);
  if (new Set(paths).size !== paths.length) {
    throw new Error('review_investigation_probe_path_duplicate');
  }
}

function assertPath(value: string, code: string): void {
  if (
    value.length === 0 ||
    value.length > 1_024 ||
    value.includes('\0') ||
    value.startsWith('/') ||
    /(?:^|\/)\.\.(?:\/|$)/u.test(value)
  ) {
    throw new Error(code);
  }
}
