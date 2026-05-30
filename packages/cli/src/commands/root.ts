import {
	type RootListResponse,
	type RootRemoveResponse,
	RootSetRequest,
	type RootSetRequestFields,
	type RootSetResponse,
	type RootSummary
} from '@cupboard/shared';
import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import { CupboardClient } from '../client.ts';
import { parseTtl } from '../duration.ts';
import { createReporter, type Reporter, type ResultRow } from '../reporter.ts';

interface RootSetOptions {
	readonly token: string;
	readonly ttl?: number;
}

interface RootOptions {
	readonly token: string;
}

export interface RootClient {
	setRoot(
		token: string,
		fields: RootSetRequestFields
	): Promise<RootSetResponse>;
	listRoots(token: string): Promise<RootListResponse>;
	removeRoot(token: string, name: string): Promise<RootRemoveResponse>;
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
		.requiredOption('--token <token>', 'admin token')
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

				await runRootSet(
					name,
					targets,
					options.ttl,
					options.token,
					reporter,
					CupboardClient.fromUrl(url)
				);
			}
		);

	root
		.command('list')
		.description('List retention roots.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.requiredOption('--token <token>', 'admin token')
		.action(async (url: string, options: RootOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});

			await runRootList(options.token, reporter, CupboardClient.fromUrl(url));
		});

	root
		.command('remove')
		.description('Remove a retention root.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<name>', 'root name to remove')
		.requiredOption('--token <token>', 'admin token')
		.action(async (url: string, name: string, options: RootOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});

			await runRootRemove(
				name,
				options.token,
				reporter,
				CupboardClient.fromUrl(url)
			);
		});
}

export async function runRootSet(
	name: string,
	targets: readonly string[],
	ttlSeconds: number | undefined,
	token: string,
	reporter: Reporter,
	client: RootClient
): Promise<void> {
	const request = RootSetRequest.fromFields({
		name,
		targets,
		...(ttlSeconds === undefined ? {} : { ttlSeconds })
	});

	const summary = await reporter.phase('Setting retention root', () =>
		client.setRoot(token, request.toFields())
	);

	reporter.result([
		{ label: 'Root', value: summary.name },
		{ label: 'Targets', value: String(summary.targets.length) },
		{ label: 'Expiry', value: describeExpiry(summary) }
	]);
}

export async function runRootList(
	token: string,
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
	token: string,
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
