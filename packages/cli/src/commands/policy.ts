import type { CliUi } from '@cupboard/cli-ui';
import type {
	GracePolicyListResponse,
	GracePolicyRemoveResponse,
	GracePolicySummary,
	RetentionPolicyListResponse,
	RetentionPolicyRemoveResponse,
	RetentionPolicySummary
} from '@cupboard/protocol/retention';
import { formatCount, type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { cacheLabel } from '../client/client.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface ConfirmableOptions {
	readonly yes?: boolean;
}
export interface PolicyClient {
	list(): Promise<RetentionPolicyListResponse>;
	remove(input: { id: string }): Promise<RetentionPolicyRemoveResponse>;
	graceList(): Promise<GracePolicyListResponse>;
	graceRemove(input: { id: string }): Promise<GracePolicyRemoveResponse>;
}

export function registerPolicyCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const policy = program
		.command('policy')
		.description('List and skip old retention policies awaiting an upgrade.');

	policy
		.command('list')
		.description('List old retention and grace policies awaiting an upgrade.')
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
		.command('remove')
		.description(
			'Skip an old retention policy so the upgrade can continue without applying it.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<id>', 'retention policy ID')
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
		.command('remove-grace')
		.description(
			'Skip an old grace policy so the upgrade can continue without applying it.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<id>', 'grace policy ID')
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
	const { policies } = await reporter.phase(
		'Listing retention policies',
		() => client.list(),
		{ humanLabel: 'Listing old retention policies' }
	);

	reporter.result({
		kind: 'retention-policies',
		title: 'Old retention policies awaiting upgrade',
		data: policies,
		rows: policies.map((policy) => policyRow(policy)),
		empty: 'No old retention policies awaiting upgrade.'
	});
}

export async function runPolicyRemove(
	id: string,
	ui: CliUi,
	client: Pick<PolicyClient, 'remove'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Skip old retention policy ${id} during this upgrade?`,
		detail:
			'The upgrade will continue without applying this old policy. Existing roots and retention settings from a completed upgrade are unchanged.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The retention policy was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase(
		'Removing retention policy',
		() => client.remove({ id }),
		{ humanLabel: 'Skipping old retention policy' }
	);

	reporter.result({
		kind: 'retention-policy',
		title: 'Old retention policy',
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

export async function runGracePolicyList(
	reporter: Reporter,
	client: Pick<PolicyClient, 'graceList'>
): Promise<void> {
	const { policies } = await reporter.phase(
		'Listing retention grace policies',
		() => client.graceList(),
		{ humanLabel: 'Listing old grace policies' }
	);

	reporter.result({
		kind: 'grace-policies',
		title: 'Old grace policies awaiting upgrade',
		data: policies,
		rows: policies.map((policy) => gracePolicyRow(policy)),
		empty: 'No old grace policies awaiting upgrade.'
	});
}

export async function runGracePolicyRemove(
	id: string,
	ui: CliUi,
	client: Pick<PolicyClient, 'graceRemove'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Skip old grace policy ${id} during this upgrade?`,
		detail:
			'The upgrade will continue without applying this old grace policy. Existing grace deadlines and settings from a completed upgrade are unchanged.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The retention grace policy was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase(
		'Removing retention grace policy',
		() => client.graceRemove({ id }),
		{ humanLabel: 'Skipping old grace policy' }
	);

	reporter.result({
		kind: 'grace-policy',
		title: 'Old grace policy',
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

// The empty prefix covers every cache. `(default)` is reserved for the unnamed
// cache, not for a prefix that matches every cache.
function cachePrefixLabel(cachePrefix: string): string {
	return cachePrefix === '' ? '(all caches)' : cachePrefix;
}
