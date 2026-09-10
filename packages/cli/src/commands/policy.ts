import type { CliUi } from '@cupboard/cli-ui';
import {
	type CacheScope,
	type GraceSeconds,
	type TtlSeconds
} from '@cupboard/nix-store/scalars';
import {
	type GraceCoverageResponse,
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

import { type Audience, audienceSchema, parseAudience } from '../audience.ts';
import { confirmAuthorizationDetails } from '../auth/attenuate.ts';
import { authenticateForPush, cachedOwnerProvider } from '../auth/auth.ts';
import { cacheTargetFromUrl, cacheTargetWithName } from '../cache-target.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { type CacheScopedClient, callInCache } from '../client/cache-scoped.ts';
import { cacheLabel, cacheNameFor, CupboardClient } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { parseGrace, parseTtl } from '../duration.ts';
import { InvalidPolicyScopeError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface PolicyAddOptions {
	readonly ttl: TtlSeconds;
}

interface PolicyAddGraceOptions {
	readonly cachePrefix: string;
	readonly grace: GraceSeconds;
}

interface GraceCoverageOptions {
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

export interface PolicyClient {
	list(): Promise<RetentionPolicyListResponse>;
	add(input: RetentionPolicyAddBody): Promise<RetentionPolicySummary>;
	remove(input: { id: string }): Promise<RetentionPolicyRemoveResponse>;
	graceList(): Promise<GracePolicyListResponse>;
	graceAdd(input: GracePolicyAddBody): Promise<GracePolicySummary>;
	graceRemove(input: { id: string }): Promise<GracePolicyRemoveResponse>;
	graceCoverage: CacheScopedClient<
		Record<string, never>,
		GraceCoverageResponse
	>;
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
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
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
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
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
				url: URL,
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
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<id>', 'policy id')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: URL, id: string, options: ConfirmableOptions) => {
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
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
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
		.action(async (url: URL, options: PolicyAddGraceOptions) => {
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
		.command('grace-coverage')
		.description(
			'Report whether a grace policy covers a cache, and the grace period a publication to that cache would receive.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('[cache]', 'named cache when the URL does not select one')
		.option(
			'--github-oidc',
			'authenticate with a GitHub Actions OIDC token (default: the cached owner login)'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the tenant URL)',
			parseAudience
		)
		.action(
			async (
				url: URL,
				cacheName: string | undefined,
				options: GraceCoverageOptions
			) => {
				const reporter = commandUi(program, programOptions).reporter();
				const urlTarget = cacheTargetFromUrl(url);
				const target =
					cacheName === undefined
						? urlTarget
						: cacheTargetWithName(urlTarget, cacheName);
				const credential = await authenticateForPush(
					CupboardClient.fromUrl(target.tenantUrl, {
						cache: target.cache,
						signal: programOptions.signal
					}),
					{
						githubOidc: options.githubOidc,
						audience:
							options.audience ?? audienceSchema.parse(target.tenantUrl),
						authorizationDetails: confirmAuthorizationDetails({
							cache: target.cache
						})
					}
				);
				const rpc = tenantRpc(target.tenantUrl, {
					credential,
					signal: programOptions.signal
				});

				await runGraceCoverage(target.cache, reporter, rpc.policies);
			}
		);

	policy
		.command('remove-grace')
		.description('Remove a retention grace policy by id.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<id>', 'grace policy id')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: URL, id: string, options: ConfirmableOptions) => {
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
	ttlSeconds: TtlSeconds,
	reporter: Reporter,
	client: Pick<PolicyClient, 'add'>
): Promise<void> {
	const body: RetentionPolicyAddBody =
		scope === 'cache'
			? {
					scope: 'cache',
					cache: { kind: 'named', name: cacheNameFor(pattern) },
					ttlSeconds
				}
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
			{
				label: summary.scope === 'cache' ? 'Cache' : 'Pattern',
				value:
					summary.scope === 'cache'
						? cacheLabel(summary.cache)
						: summary.pattern
			},
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
		detail:
			'Existing roots keep their expiry. New roots no longer use this policy.'
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
		value: `${policy.scope} ${
			policy.scope === 'cache' ? cacheLabel(policy.cache) : policy.pattern
		}; ${formatCount(policy.ttlSeconds)}s`
	};
}

export async function runGraceCoverage(
	cache: CacheScope,
	reporter: Reporter,
	client: Pick<PolicyClient, 'graceCoverage'>
): Promise<void> {
	const coverage = await reporter.phase('Reading grace coverage', () =>
		callInCache(client.graceCoverage, cache, {})
	);

	reporter.result({
		kind: 'grace-coverage',
		data: coverage,
		rows: [
			{ label: 'Cache', value: cacheLabel(cache) },
			{ label: 'Covered', value: coverage.covered ? 'yes' : 'no' },
			...(coverage.covered
				? [
						{
							label: 'Grace (seconds)',
							value: formatCount(coverage.graceSeconds)
						}
					]
				: [])
		]
	});
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
	graceSeconds: GraceSeconds,
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

// The empty prefix covers every cache, and is rendered the same way as the
// empty prefix in the reuse-view selectors. `(default)` is reserved for the
// unnamed cache, not for a prefix that matches every cache.
function cachePrefixLabel(cachePrefix: string): string {
	return cachePrefix === '' ? '(all caches)' : cachePrefix;
}
