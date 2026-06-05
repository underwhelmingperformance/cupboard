import type {
	RootListResponse,
	RootRemoveResponse,
	RootSetBody,
	RootSetResponse,
	RootSummary
} from '@cupboard/protocol/retention';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client.ts';
import { parseTtl } from '../duration.ts';
import { createReporter, type Reporter, type ResultRow } from '../reporter.ts';

interface RootSetOptions {
	readonly token: string;
	readonly ttl?: number;
	readonly cache?: string;
}

interface RootOptions {
	readonly token: string;
	readonly cache?: string;
}

export interface RootClient {
	setRoot(
		token: AccessCredential,
		name: string,
		body: RootSetBody
	): Promise<RootSetResponse>;
	listRoots(token: AccessCredential): Promise<RootListResponse>;
	removeRoot(
		token: AccessCredential,
		name: string
	): Promise<RootRemoveResponse>;
}

export function registerRootCommands(program: Command): void {
	const root = program
		.command('root')
		.description(
			'Manage retention roots: named channels of store paths to keep.'
		);

	root
		.command('set')
		.description('Create or replace a retention root with the given targets.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<name>', 'root name, e.g. github:owner/repo/main')
		.argument('<store-path...>', 'one or more top-level store paths to retain')
		.option(
			'--ttl <duration>',
			'expire the root after this duration (e.g. 7d, 12h)',
			parseTtl
		)
		.option('--cache <name>', 'target a named cache rather than the default')
		.action(
			async (
				url: string,
				name: string,
				targets: string[],
				options: RootSetOptions
			) => {
				const reporter = createReporter({
					mode: reporterModeFromGlobals(program)
				});
				const client = CupboardClient.fromUrl(url, options.cache);
				const token = cachedOwnerProvider();

				await runRootSet(name, targets, options.ttl, token, reporter, client);
			}
		);

	root
		.command('list')
		.description('List retention roots.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.option('--cache <name>', 'target a named cache rather than the default')
		.action(async (url: string, options: RootOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url, options.cache);
			const token = cachedOwnerProvider();

			await runRootList(token, reporter, client);
		});

	root
		.command('remove')
		.description('Remove a retention root.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<name>', 'root name to remove')
		.option('--cache <name>', 'target a named cache rather than the default')
		.action(async (url: string, name: string, options: RootOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url, options.cache);
			const token = cachedOwnerProvider();

			await runRootRemove(name, token, reporter, client);
		});
}

export async function runRootSet(
	name: string,
	targets: readonly string[],
	ttlSeconds: number | undefined,
	token: AccessCredential,
	reporter: Reporter,
	client: RootClient
): Promise<void> {
	const body: RootSetBody = {
		targets: [...targets],
		...(ttlSeconds === undefined ? {} : { ttlSeconds })
	};

	const summary = await reporter.phase('Setting retention root', () =>
		client.setRoot(token, name, body)
	);

	reporter.result([
		{ label: 'Root', value: summary.name },
		{ label: 'Targets', value: String(summary.targets.length) },
		{ label: 'Expiry', value: describeExpiry(summary) }
	]);
}

export async function runRootList(
	token: AccessCredential,
	reporter: Reporter,
	client: RootClient
): Promise<void> {
	const { roots } = await reporter.phase('Listing retention roots', () =>
		client.listRoots(token)
	);

	if (roots.length === 0) {
		reporter.info('No retention roots.');
		return;
	}

	reporter.result(roots.map((root) => rootListRow(root)));
}

export async function runRootRemove(
	name: string,
	token: AccessCredential,
	reporter: Reporter,
	client: RootClient
): Promise<void> {
	const result = await reporter.phase('Removing retention root', () =>
		client.removeRoot(token, name)
	);

	reporter.result([
		{ label: 'Root', value: result.name },
		{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
	]);
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
		return `expired (${summary.expiresAt})`;
	}

	return `expires ${summary.expiresAt}`;
}
