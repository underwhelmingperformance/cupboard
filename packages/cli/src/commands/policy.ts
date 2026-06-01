import {
	type RetentionPolicyAddBody,
	type RetentionPolicyListResponse,
	type RetentionPolicyRemoveResponse,
	type RetentionPolicyScope,
	retentionPolicyScopeSchema,
	type RetentionPolicySummary
} from '@cupboard/shared';
import type { Command } from 'commander';

import { authenticate } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client.ts';
import { parseTtl } from '../duration.ts';
import { InvalidPolicyScopeError } from '../errors.ts';
import {
	createReporter,
	formatCount,
	type Reporter,
	type ResultRow
} from '../reporter.ts';

interface PolicyOptions {
	readonly token: string;
}

interface PolicyAddOptions {
	readonly token: string;
	readonly ttl: number;
}

export interface PolicyClient {
	listPolicies(token: AccessCredential): Promise<RetentionPolicyListResponse>;
	addPolicy(
		token: AccessCredential,
		body: RetentionPolicyAddBody
	): Promise<RetentionPolicySummary>;
	removePolicy(
		token: AccessCredential,
		id: string
	): Promise<RetentionPolicyRemoveResponse>;
}

function parseScope(value: string): RetentionPolicyScope {
	const result = retentionPolicyScopeSchema.safeParse(value);

	if (!result.success) {
		throw new InvalidPolicyScopeError(value);
	}

	return result.data;
}

export function registerPolicyCommands(program: Command): void {
	const policy = program
		.command('policy')
		.description('Manage retention policies: default TTLs by cache or prefix.');

	policy
		.command('list')
		.description('List retention policies.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.requiredOption('--token <token>', 'bootstrap secret')
		.action(async (url: string, options: PolicyOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = await authenticate(client, options.token);

			await runPolicyList(token, reporter, client);
		});

	policy
		.command('add')
		.description('Add a retention policy.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<scope>', 'cache | root-name-prefix')
		.argument('<pattern>', 'a cache name, or a root-name prefix')
		.requiredOption(
			'--ttl <duration>',
			'default TTL for matching roots (e.g. 14d, 12h)',
			parseTtl
		)
		.requiredOption('--token <token>', 'bootstrap secret')
		.action(
			async (
				url: string,
				scope: string,
				pattern: string,
				options: PolicyAddOptions
			) => {
				const reporter = createReporter({
					mode: reporterModeFromGlobals(program)
				});
				const client = CupboardClient.fromUrl(url);
				const token = await authenticate(client, options.token);

				await runPolicyAdd(
					parseScope(scope),
					pattern,
					options.ttl,
					token,
					reporter,
					client
				);
			}
		);

	policy
		.command('remove')
		.description('Remove a retention policy by id.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<id>', 'policy id')
		.requiredOption('--token <token>', 'bootstrap secret')
		.action(async (url: string, id: string, options: PolicyOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);
			const token = await authenticate(client, options.token);

			await runPolicyRemove(id, token, reporter, client);
		});
}

export async function runPolicyList(
	token: AccessCredential,
	reporter: Reporter,
	client: PolicyClient
): Promise<void> {
	const { policies } = await reporter.phase('Listing retention policies', () =>
		client.listPolicies(token)
	);

	if (policies.length === 0) {
		reporter.info('No retention policies.');
		return;
	}

	reporter.result(policies.map((policy) => policyRow(policy)));
}

export async function runPolicyAdd(
	scope: RetentionPolicyScope,
	pattern: string,
	ttlSeconds: number,
	token: AccessCredential,
	reporter: Reporter,
	client: PolicyClient
): Promise<void> {
	const body: RetentionPolicyAddBody =
		scope === 'cache'
			? { scope: 'cache', pattern, ttlSeconds }
			: { scope: 'root-name-prefix', pattern, ttlSeconds };

	const summary = await reporter.phase('Adding retention policy', () =>
		client.addPolicy(token, body)
	);

	reporter.result([
		{ label: 'Policy', value: summary.id },
		{ label: 'Scope', value: summary.scope },
		{ label: 'Pattern', value: summary.pattern },
		{ label: 'TTL (seconds)', value: formatCount(summary.ttlSeconds) }
	]);
}

export async function runPolicyRemove(
	id: string,
	token: AccessCredential,
	reporter: Reporter,
	client: PolicyClient
): Promise<void> {
	const result = await reporter.phase('Removing retention policy', () =>
		client.removePolicy(token, id)
	);

	reporter.result([
		{ label: 'Policy', value: result.id },
		{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
	]);
}

function policyRow(policy: RetentionPolicySummary): ResultRow {
	return {
		label: policy.id,
		value: `${policy.scope} ${policy.pattern}; ${formatCount(policy.ttlSeconds)}s`
	};
}
