export type DiscussionMode = 'off' | 'suggest';

export type DiscussionIntent =
  'question' | 'disagreement' | 'dismiss_request' | 'fix_claim' | 'other';

export type DiscussionSuggestedAction =
  'none' | 'suggest_rr_skip' | 'ask_for_details';

export interface DiscussionComment {
  id: number;
  body: string;
  author: string;
  isBot: boolean;
  createdAt?: string;
  inReplyToId?: number | null;
}

export interface ReviewDiscussionContext {
  repository: string;
  pullRequestNumber: number;
  headSha?: string;
  parent: {
    id: number;
    path?: string;
    line?: number | null;
    diffHunk?: string | null;
    body: string;
    severity: string;
    title?: string;
  };
  userComment: DiscussionComment;
  thread: DiscussionComment[];
}

export interface DiscussionResponse {
  intent: DiscussionIntent;
  confidence: number;
  agreesWithUser: boolean;
  answer: string;
  suggestedAction: DiscussionSuggestedAction;
}

export interface DiscussionResponder {
  respond(context: ReviewDiscussionContext): Promise<DiscussionResponse>;
}
