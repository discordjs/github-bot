import type { EmitterWebhookEvent } from '@octokit/webhooks/types';
import type { Octokit } from 'octokit';
import { pino } from 'pino';

export interface Env {
	APP_ID: string;
	PACK_STORAGE: KVNamespace;
	PRIVATE_KEY: string;
	WEBHOOK_SECRET: string;
}

export interface PackInfo {
	commentId: number;
	prNumber: number;
	tag: string;
	workflowRunId: number;
}

export const logger = pino({ level: 'debug' });

export type IssueCommentCreatedData = EmitterWebhookEvent<'issue_comment.created'> & { octokit: Octokit };
export type IssueCommentEditedData = EmitterWebhookEvent<'issue_comment.edited'> & { octokit: Octokit };
export type WorkflowRunCompletedData = EmitterWebhookEvent<'workflow_run.completed'> & { octokit: Octokit };
