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
		.description(
			"List and remove old retention policies that an upgrade hasn't imported yet."
		);

	policy
		.command('list')
		.description(
			"List the old retention and grace policies that haven't been imported yet."
		)
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
			'Remove an old retention policy, so that the import can continue without it.'
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
			'Remove an old grace policy, so that the import can continue without it.'
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

export async function runPolicyRemove(
	id: string,
	ui: CliUi,
	client: Pick<PolicyClient, 'remove'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove retention policy ${id}?`,
		detail:
			'The pending migration restarts from the remaining policies. Existing roots and settings from a completed migration are unchanged.'
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

export async function runGracePolicyRemove(
	id: string,
	ui: CliUi,
	client: Pick<PolicyClient, 'graceRemove'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove retention grace policy ${id}?`,
		detail:
			'The pending migration restarts from the remaining policies. Existing grace deadlines and settings from a completed migration are unchanged.'
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

// The empty prefix covers every cache. `(default)` is reserved for the unnamed
// cache, not for a prefix that matches every cache.
function cachePrefixLabel(cachePrefix: string): string {
	return cachePrefix === '' ? '(all caches)' : cachePrefix;
}
