import type { HandlerFunction } from '@octokit/webhooks/types';
import { pino } from 'pino';

export interface Env {
	APP_ID: string;
	PRIVATE_KEY: string;
	WEBHOOK_SECRET: string;
}

export const logger = pino({ level: 'debug' });

export type IssueCommentCreatedData = Parameters<HandlerFunction<'issue_comment.created'>>[0];
export type IssueCommentEditedData = Parameters<HandlerFunction<'issue_comment.edited'>>[0];
