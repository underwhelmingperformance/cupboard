import type { CliUi } from '@cupboard/cli-ui';
import {
	type GracePolicyAddBody,
	type GracePolicyListResponse,
	type GracePolicyRemoveResponse,
	type GracePolicySummary,
	type RetentionPolicyAddBody,
	type RetentionPolicyListResponse,
	type RetentionPolicyRemoveResponse,
	type RetentionPolicyScope,
	retentionPolicyScopeSchema,
	type RetentionPolicySummary
} from '@cupboard/protocol/retention';
import { formatCount, type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseGrace, parseTtl } from '../duration.ts';
import { InvalidPolicyScopeError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface PolicyAddOptions {
	readonly ttl: number;
}

interface PolicyAddGraceOptions {
	readonly cachePrefix: string;
	readonly grace: number;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

/**
 * The slice of the derived client the policy commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).policies`
 * satisfies it by construction.
 */
export interface PolicyClient {
	list(): Promise<RetentionPolicyListResponse>;
	add(input: RetentionPolicyAddBody): Promise<RetentionPolicySummary>;
	remove(input: { id: string }): Promise<RetentionPolicyRemoveResponse>;
	graceList(): Promise<GracePolicyListResponse>;
	graceAdd(input: GracePolicyAddBody): Promise<GracePolicySummary>;
	graceRemove(input: { id: string }): Promise<GracePolicyRemoveResponse>;
}

function parseScope(value: string): RetentionPolicyScope {
	const result = retentionPolicyScopeSchema.safeParse(value);

	if (!result.success) {
		throw new InvalidPolicyScopeError(value);
	}

	return result.data;
}

export function registerPolicyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const policy = program
		.command('policy')
		.description('Manage retention policies: default TTLs by cache or prefix.');

	policy
		.command('list')
		.description('List retention policies and retention grace policies.')
		.argument('<url>', tenantUrlArgument)
		.action(async (url: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runPolicyList(reporter, rpc.policies);
			await runGracePolicyList(reporter, rpc.policies);
		});

	policy
		.command('add')
		.description('Add a retention policy.')
		.argument('<url>', tenantUrlArgument)
		.argument('<scope>', 'cache | root-name-prefix')
		.argument('<pattern>', 'a cache name, or a root-name prefix')
		.requiredOption(
			'--ttl <duration>',
			'default TTL for matching roots (e.g. 14d, 12h)',
			parseTtl
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # Default 14-day retention for roots in a named cache',
				'  cupboard policy add https://cupboard.example.workers.dev/t/acme \\',
				'    cache builds --ttl 14d'
			].join('\n')
		)
		.action(
			async (
				url: string,
				scope: string,
				pattern: string,
				options: PolicyAddOptions
			) => {
				const reporter = commandUi(program, programOptions).reporter();
				const rpc = tenantRpc(url, {
					credential: cachedOwnerProvider(url, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

				await runPolicyAdd(
					parseScope(scope),
					pattern,
					options.ttl,
					reporter,
					rpc.policies
				);
			}
		);

	policy
		.command('remove')
		.description('Remove a retention policy by id.')
		.argument('<url>', tenantUrlArgument)
		.argument('<id>', 'policy id')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: string, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runPolicyRemove(id, ui, rpc.policies);
		});

	policy
		.command('add-grace')
		.description(
			'Add or update a retention grace policy for a cache-name prefix.'
		)
		.argument('<url>', tenantUrlArgument)
		.option(
			'--cache-prefix <prefix>',
			'cache-name prefix to match (default: the empty string, the tenant-wide default)',
			''
		)
		.requiredOption(
			'--grace <duration>',
			'grace period applied to matching publications (e.g. 24h, 0s)',
			parseGrace
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # 24-hour grace for every cache whose name starts with "pr-"',
				'  cupboard policy add-grace https://cupboard.example.workers.dev/t/acme \\',
				'    --cache-prefix pr- --grace 24h'
			].join('\n')
		)
		.action(async (url: string, options: PolicyAddGraceOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runGracePolicyAdd(
				options.cachePrefix,
				options.grace,
				reporter,
				rpc.policies
			);
		});

	policy
		.command('remove-grace')
		.description('Remove a retention grace policy by id.')
		.argument('<url>', tenantUrlArgument)
		.argument('<id>', 'grace policy id')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: string, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runGracePolicyRemove(id, ui, rpc.policies);
		});
}

export async function runPolicyList(
	reporter: Reporter,
	client: Pick<PolicyClient, 'list'>
): Promise<void> {
	const { policies } = await reporter.phase('Listing retention policies', () =>
		client.list()
	);

	reporter.result({
		kind: 'retention-policies',
		data: policies,
		rows: policies.map((policy) => policyRow(policy)),
		empty: 'No retention policies.'
	});
}

export async function runPolicyAdd(
	scope: RetentionPolicyScope,
	pattern: string,
	ttlSeconds: number,
	reporter: Reporter,
	client: Pick<PolicyClient, 'add'>
): Promise<void> {
	const body: RetentionPolicyAddBody =
		scope === 'cache'
			? { scope: 'cache', pattern, ttlSeconds }
			: { scope: 'root-name-prefix', pattern, ttlSeconds };

	const summary = await reporter.phase('Adding retention policy', () =>
		client.add(body)
	);

	reporter.result({
		kind: 'retention-policy',
		data: summary,
		rows: [
			{ label: 'Policy', value: summary.id },
			{ label: 'Scope', value: summary.scope },
			{ label: 'Pattern', value: summary.pattern },
			{ label: 'TTL (seconds)', value: formatCount(summary.ttlSeconds) }
		]
	});
}

export async function runPolicyRemove(
	id: string,
	ui: CliUi,
	client: PolicyClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove retention policy ${id}?`,
		detail: 'Paths kept only by this policy fall back to the default retention.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The retention policy was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Removing retention policy', () =>
		client.remove({ id })
	);

	reporter.result({
		kind: 'retention-policy',
		data: result,
		rows: [
			{ label: 'Policy', value: result.id },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
		]
	});
}

function policyRow(policy: RetentionPolicySummary): ResultRow {
	return {
		label: policy.id,
		value: `${policy.scope} ${policy.pattern}; ${formatCount(policy.ttlSeconds)}s`
	};
}

export async function runGracePolicyList(
	reporter: Reporter,
	client: Pick<PolicyClient, 'graceList'>
): Promise<void> {
	const { policies } = await reporter.phase(
		'Listing retention grace policies',
		() => client.graceList()
	);

	reporter.result({
		kind: 'grace-policies',
		data: policies,
		rows: policies.map((policy) => gracePolicyRow(policy)),
		empty: 'No retention grace policies.'
	});
}

export async function runGracePolicyAdd(
	cachePrefix: string,
	graceSeconds: number,
	reporter: Reporter,
	client: Pick<PolicyClient, 'graceAdd'>
): Promise<void> {
	const summary = await reporter.phase('Adding retention grace policy', () =>
		client.graceAdd({ cachePrefix, graceSeconds })
	);

	reporter.result({
		kind: 'grace-policy',
		data: summary,
		rows: [
			{ label: 'Policy', value: summary.id },
			{ label: 'Cache prefix', value: cachePrefixLabel(summary.cachePrefix) },
			{ label: 'Grace (seconds)', value: formatCount(summary.graceSeconds) }
		]
	});
}

export async function runGracePolicyRemove(
	id: string,
	ui: CliUi,
	client: Pick<PolicyClient, 'graceRemove'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove retention grace policy ${id}?`,
		detail:
			'Publications to matching caches stop receiving a grace deadline; existing deadlines are unaffected.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The retention grace policy was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Removing retention grace policy', () =>
		client.graceRemove({ id })
	);

	reporter.result({
		kind: 'grace-policy',
		data: result,
		rows: [
			{ label: 'Policy', value: result.id },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
		]
	});
}

function gracePolicyRow(policy: GracePolicySummary): ResultRow {
	return {
		label: policy.id,
		value: `${cachePrefixLabel(policy.cachePrefix)}; ${formatCount(policy.graceSeconds)}s`
	};
}

// The empty prefix covers every cache, so it renders like the reuse-view
// selectors' empty prefix does; `(default)` stays reserved for the unnamed
// cache itself, which the empty prefix is not.
function cachePrefixLabel(cachePrefix: string): string {
	return cachePrefix === '' ? '(all caches)' : cachePrefix;
}
