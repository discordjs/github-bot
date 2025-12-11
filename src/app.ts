import type { Octokit } from 'octokit';
import { App } from 'octokit';
import {
	logger,
	type Env,
	type IssueCommentCreatedData,
	type IssueCommentEditedData,
	type PackInfo,
	type WorkflowRunCompletedData,
} from './util.js';

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

async function commentHandler(data: IssueCommentCreatedData | IssueCommentEditedData, env: Env) {
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
	} = await data.octokit.rest.repos.getCollaboratorPermissionLevel({
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
			data.octokit,
			data.payload.repository.owner.login,
			data.payload.repository.name,
			data.payload.issue.number,
		))
	) {
		return;
	}

	logger.debug('Beginning the pack process...');

	// Don't await, we don't mind if reactions fail/even go through, just get started on the workflow
	void data.octokit.rest.reactions
		.createForIssueComment({
			owner: data.payload.repository.owner.login,
			repo: data.payload.repository.name,
			comment_id: data.payload.comment.id,
			content: 'eyes',
		})
		// eslint-disable-next-line promise/prefer-await-to-then
		.catch((error) => logger.warn({ err: error }, 'Failed to update reactions on start'));

	const ref = `refs/pull/${data.payload.issue.number}/head`;
	const tag = `pr-${data.payload.issue.number}`;
	logger.info(
		{
			ref,
			tag,
			pr: data.payload.issue.number,
		},
		'Triggering release workflow',
	);

	// Trigger the publish-dev workflow
	await data.octokit.rest.actions.createWorkflowDispatch({
		owner: 'discordjs',
		repo: 'discord.js',
		workflow_id: 'publish-dev.yml',
		ref: 'main',
		inputs: {
			ref,
			tag,
			dry_run: 'false',
		},
	});

	// Absurdly, the above API call returns 204 No Content and provides no real output, so we have to resort to this
	// eslint-disable-next-line no-promise-executor-return
	await new Promise((resolve) => setTimeout(resolve, 5_000));

	// Get the workflow runs to find the one we just triggered
	const { data: workflowRuns } = await data.octokit.rest.actions.listWorkflowRuns({
		owner: 'discordjs',
		repo: 'discord.js',
		workflow_id: 'publish-dev.yml',
		per_page: 5,
	});

	// Find the most recent workflow run that matches our tag
	const workflowRun = workflowRuns.workflow_runs.find(
		(run) => run.event === 'workflow_dispatch' && run.status !== 'completed',
	);

	if (!workflowRun) {
		logger.warn('Could not find the workflow run that was just triggered');
		return;
	}

	// Store pack info with workflow run ID as the key
	const packInfo: PackInfo = {
		prNumber: data.payload.issue.number,
		commentId: data.payload.comment.id,
		tag,
		workflowRunId: workflowRun.id,
	};
	await env.PACK_STORAGE.put(`pack-${workflowRun.id}`, JSON.stringify(packInfo), { expirationTtl: 3_600 });

	logger.info('Release workflow triggered successfully');
}

async function workflowRunHandler(data: WorkflowRunCompletedData, env: Env) {
	logger.debug('in workflow_run handler');

	// Sanity checks

	// Only handle the publish-dev workflow
	if (data.payload.workflow_run.name !== 'Publish dev') {
		logger.debug({ workflow: data.payload.workflow_run.name }, 'Ignoring non-publish workflow');
		return;
	}

	// Check if workflow was triggered via workflow_dispatch (by the bot or a human)
	if (data.payload.workflow_run.event !== 'workflow_dispatch') {
		logger.debug({ event: data.payload.workflow_run.event }, 'Workflow not triggered by workflow_dispatch');
		return;
	}

	// Only handle successful workflows
	if (data.payload.workflow_run.conclusion !== 'success') {
		logger.debug({ conclusion: data.payload.workflow_run.conclusion }, 'Workflow did not succeed');
		return;
	}

	// Check if this was triggered by THIS bot specifically
	// Get the authenticated app information
	const { data: appInfo } = await data.octokit.rest.apps.getAuthenticated();
	if (data.payload.workflow_run.triggering_actor?.login !== `${appInfo!.slug}[bot]`) {
		logger.debug(
			{
				actor: data.payload.workflow_run.triggering_actor?.login,
				expected: `${appInfo!.slug}[bot]`,
			},
			'Workflow not triggered by this bot',
		);
		return;
	}

	// Look up pack info by workflow run ID
	const packKey = `pack-${data.payload.workflow_run.id}`;
	const stored = await env.PACK_STORAGE.get(packKey);

	if (!stored) {
		logger.debug({ workflowRunId: data.payload.workflow_run.id }, 'No pack info found for this workflow run');
		return;
	}

	const { prNumber, commentId, tag }: PackInfo = JSON.parse(stored);
	// Delete the key as we've consumed it
	await env.PACK_STORAGE.delete(packKey);

	logger.info(
		{
			pr: prNumber,
			tag,
			workflow: data.payload.workflow_run.id,
			triggering_actor: data.payload.workflow_run.triggering_actor?.login,
		},
		'Workflow completed, posting comment',
	);

	// Post a comment on the PR
	try {
		await data.octokit.rest.issues.createComment({
			owner: data.payload.repository.owner.login,
			repo: data.payload.repository.name,
			issue_number: prNumber,
			body: `📦 Packages from this PR have been published with the tag \`${tag}\`.\n\nFor discord.js using npm:\n\`\`\`bash\nnpm install discord.js@${tag}\n\`\`\``,
		});

		logger.info('Comment posted successfully');

		// Remove the eyes reaction from the original trigger comment using stored commentId
		const { data: reactions } = await data.octokit.rest.reactions.listForIssueComment({
			owner: data.payload.repository.owner.login,
			repo: data.payload.repository.name,
			comment_id: commentId,
		});

		const eyesReaction = reactions.find((reaction) => reaction.content === 'eyes');
		if (eyesReaction) {
			await data.octokit.rest.reactions
				.deleteForIssueComment({
					owner: data.payload.repository.owner.login,
					repo: data.payload.repository.name,
					reaction_id: eyesReaction.id,
					comment_id: commentId,
				})

				.catch((error) => logger.warn({ err: error }, 'Failed to remove eyes reaction'));
		} else {
			logger.debug({ reactions }, 'No eyes reaction found to remove');
		}
	} catch (error) {
		logger.error({ err: error }, 'Failed to post comment');
	}
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
	app.webhooks.onError((err) => logger.error(err));
	app.webhooks.on('issue_comment.created', async (data) => commentHandler(data, env));
	app.webhooks.on('issue_comment.edited', async (data) => commentHandler(data, env));
	app.webhooks.on('workflow_run.completed', async (data) => workflowRunHandler(data, env));

	return app;
}
