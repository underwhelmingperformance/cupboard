import { type CliUi, createCliUi } from '@cupboard/cli-ui';
import { DEFAULT_CACHE, selectorForCache } from '@cupboard/nix/scalars';
import type {
	RootListResponse,
	RootRemoveResponse,
	RootSetResponse,
	RootSummary
} from '@cupboard/protocol/retention';
import {
	formatTimestamp,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseTtl } from '../duration.ts';
import { tenantUrlArgument } from '../url-argument.ts';

interface RootSetOptions {
	readonly ttl?: number;
	readonly cache?: string;
}

interface RootOptions {
	readonly cache?: string;
	readonly yes?: boolean;
}

/**
 * The slice of the derived client the root commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).roots`
 * satisfies it by construction.
 */
export interface RootClient {
	set(input: {
		cacheName: string;
		name: string;
		targets: string[];
		ttlSeconds?: number;
	}): Promise<RootSetResponse>;
	list(input: { cacheName: string }): Promise<RootListResponse>;
	remove(input: {
		cacheName: string;
		name: string;
	}): Promise<RootRemoveResponse>;
}

export function registerRootCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const root = program
		.command('root')
		.description(
			'Manage retention roots: named channels of store paths to keep.'
		);

	root
		.command('set')
		.description('Create or replace a retention root with the given targets.')
		.argument('<url>', tenantUrlArgument)
		.argument('<name>', 'root name, e.g. github:owner/repo/main')
		.argument('<store-path...>', 'one or more top-level store paths to retain')
		.option(
			'--ttl <duration>',
			'expire the root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--cache <name>', 'target a named cache rather than the default')
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				"  # Keep a channel's top-level paths, expiring after 30 days",
				'  cupboard root set https://cupboard.example.workers.dev/t/acme \\',
				'    github:acme/infra/main /nix/store/<hash>-app --ttl 30d'
			].join('\n')
		)
		.action(
			async (
				url: string,
				name: string,
				targets: string[],
				options: RootSetOptions
			) => {
				const reporter = createCliUi({
					mode: reporterModeFromGlobals(program)
				}).reporter();
				const rpc = tenantRpc(url, {
					credential: cachedOwnerProvider(url, {
						signal: programOptions.signal
					}),
					signal: programOptions.signal
				});

				await runRootSet(
					selectorForCache(options.cache ?? DEFAULT_CACHE),
					name,
					targets,
					options.ttl,
					reporter,
					rpc.roots
				);
			}
		);

	root
		.command('list')
		.description('List retention roots.')
		.argument('<url>', tenantUrlArgument)
		.option('--cache <name>', 'target a named cache rather than the default')
		.action(async (url: string, options: RootOptions) => {
			const reporter = createCliUi({
				mode: reporterModeFromGlobals(program)
			}).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runRootList(
				selectorForCache(options.cache ?? DEFAULT_CACHE),
				reporter,
				rpc.roots
			);
		});

	root
		.command('remove')
		.description('Remove a retention root.')
		.argument('<url>', tenantUrlArgument)
		.argument('<name>', 'root name to remove')
		.option('--cache <name>', 'target a named cache rather than the default')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: string, name: string, options: RootOptions) => {
			const ui = createCliUi({
				mode: reporterModeFromGlobals(program),
				assumeYes: options.yes
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runRootRemove(
				selectorForCache(options.cache ?? DEFAULT_CACHE),
				name,
				ui,
				rpc.roots
			);
		});
}

export async function runRootSet(
	cacheName: string,
	name: string,
	targets: readonly string[],
	ttlSeconds: number | undefined,
	reporter: Reporter,
	client: RootClient
): Promise<void> {
	const summary = await reporter.phase('Setting retention root', () =>
		client.set({
			cacheName,
			name,
			targets: [...targets],
			...(ttlSeconds === undefined ? {} : { ttlSeconds })
		})
	);

	reporter.result({
		kind: 'root',
		data: summary,
		rows: [
			{ label: 'Root', value: summary.name },
			{ label: 'Targets', value: String(summary.targets.length) },
			{ label: 'Expiry', value: describeExpiry(summary) }
		]
	});
}

export async function runRootList(
	cacheName: string,
	reporter: Reporter,
	client: RootClient
): Promise<void> {
	const { roots } = await reporter.phase('Listing retention roots', () =>
		client.list({ cacheName })
	);

	if (roots.length === 0) {
		reporter.info('No retention roots.');
		return;
	}

	reporter.result({
		kind: 'roots',
		data: roots,
		rows: roots.map((root) => rootListRow(root))
	});
}

export async function runRootRemove(
	cacheName: string,
	name: string,
	ui: CliUi,
	client: RootClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove retention root ${name}?`,
		detail: 'Paths kept only by this root become eligible for collection.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The retention root was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Removing retention root', () =>
		client.remove({ cacheName, name })
	);

	reporter.result({
		kind: 'root',
		data: result,
		rows: [
			{ label: 'Root', value: result.name },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
		]
	});
}

function rootListRow(root: RootSummary): ResultRow {
	return {
		label: root.name,
		value: `${String(root.targets.length)} target(s); ${describeExpiry(root)}`
	};
}

export function describeExpiry(summary: RootSummary): string {
	if (summary.expiresAt === undefined) {
		return 'permanent';
	}

	if (summary.expired) {
		return `expired (${formatTimestamp(summary.expiresAt)})`;
	}

	return `expires ${formatTimestamp(summary.expiresAt)}`;
}
