import type { Octokit } from 'octokit';
import { App } from 'octokit';
import { logger, type Env, type IssueCommentCreatedData, type IssueCommentEditedData } from './util.js';

async function isPRGreen(octokit: Octokit, owner: string, repo: string, pullNumber: number): Promise<boolean> {
	// First, get the PR data to get the head SHA
	const { data: pullRequest } = await octokit.rest.pulls.get({
		owner,
		repo,
		pull_number: pullNumber,
	});

	// Get the status of the head commit
	const { data: statusData } = await octokit.rest.repos.getCombinedStatusForRef({
		owner,
		repo,
		ref: pullRequest.head.sha,
	});

	// Get the check runs for the head commit
	const { data: checkRunsData } = await octokit.rest.checks.listForRef({
		owner,
		repo,
		ref: pullRequest.head.sha,
	});

	// Group check runs by name and keep only the latest run for each check
	const latestCheckRuns = checkRunsData.check_runs.reduce<Record<string, (typeof checkRunsData.check_runs)[number]>>(
		(latest, run) => {
			// If we haven't seen this check before or this run is newer, update
			if (!latest[run.name] || new Date(run.completed_at!) > new Date(latest[run.name]!.completed_at!)) {
				latest[run.name] = run;
			}

			return latest;
		},
		{},
	);

	const failedChecks = Object.values(latestCheckRuns).filter(
		(run) =>
			run.status === 'completed' &&
			run.conclusion !== 'success' &&
			run.conclusion !== 'neutral' &&
			// This is often our label CI
			run.conclusion !== 'skipped',
	);

	const isGreen = statusData.state === 'success' && failedChecks.length === 0;
	logger.debug(
		{
			isGreen,
			status: statusData.state,
			failedChecks,
		},
		'PR green check',
	);

	return isGreen;
}

export function getApp(env: Env) {
	const app = new App({
		appId: env.APP_ID,
		privateKey: env.PRIVATE_KEY.replaceAll('\\n', '\n'),
		webhooks: {
			secret: env.WEBHOOK_SECRET,
		},
	});

	// eslint-disable-next-line promise/prefer-await-to-callbacks
	app.webhooks.onError((err) => {
		logger.error({ err }, 'Webhook error');
	});

	const commentHandler = async (data: IssueCommentCreatedData | IssueCommentEditedData) => {
		logger.debug('in comment handler');

		if (!data.payload.comment.body.startsWith('@discord-js-bot pack this')) {
			logger.debug({ body: data.payload.comment.body }, 'Comment does not start with "@discord-js-bot pack this"');
			return;
		}

		if (!data.payload.comment.user) {
			logger.debug('Comment does not have a user associated with it');
			return;
		}

		if (!data.payload.issue.pull_request || data.payload.issue.state !== 'open') {
			logger.debug('Comment is not on a pull request or pull request is not open');
			return;
		}

		const {
			data: { permission },
		} = await app.octokit.rest.repos.getCollaboratorPermissionLevel({
			owner: data.payload.repository.owner.login,
			repo: data.payload.repository.name,
			username: data.payload.comment.user.login,
		});

		if (permission !== 'admin' && permission !== 'write') {
			logger.debug(`User ${data.payload.comment.user.login} does not have sufficient permissions to pack.`);
			return;
		}

		if (
			!(await isPRGreen(
				app.octokit,
				data.payload.repository.owner.login,
				data.payload.repository.name,
				data.payload.issue.number,
			))
		) {
			return;
		}

		logger.debug('Beginning the pack process...');
	};

	app.webhooks.on('issue_comment.created', commentHandler);
	app.webhooks.on('issue_comment.edited', commentHandler);

	return app;
}
