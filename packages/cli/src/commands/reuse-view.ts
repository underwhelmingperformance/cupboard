import type { CliUi } from '@cupboard/cli-ui';
import type { CacheAccessMode } from '@cupboard/nix-store/scalars';
import {
	type ReuseViewListResponse,
	type ReuseViewPriority,
	reuseViewPrioritySchema,
	type ReuseViewRemoveResponse,
	type ReuseViewSelector,
	reuseViewSelectorSchema,
	type ReuseViewSummary
} from '@cupboard/protocol/reuse-views';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { parseCacheAccess } from '../cache-access.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	InvalidReuseViewPriorityError,
	InvalidReuseViewSelectorError,
	ReuseViewSelectorRequiredError
} from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export interface ReuseViewSetOptions {
	readonly select: readonly ReuseViewSelector[];
	readonly access?: CacheAccessMode;
	readonly priority?: ReuseViewPriority;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

export interface ReuseViewClient {
	list(): Promise<ReuseViewListResponse>;
	set(input: {
		name: string;
		access: CacheAccessMode;
		selectors: ReuseViewSelector[];
		priority?: number;
	}): Promise<ReuseViewSummary>;
	remove(input: { name: string }): Promise<ReuseViewRemoveResponse>;
}

function collectSelector(
	value: string,
	previous: readonly ReuseViewSelector[]
): ReuseViewSelector[] {
	const selector = parseSelector(value);

	return [...previous, selector];
}

export function parseSelector(value: string): ReuseViewSelector {
	const candidate: unknown =
		value === 'default'
			? { kind: 'default' }
			: value === 'all'
				? { kind: 'all' }
				: value === 'all-named'
					? { kind: 'all-named' }
					: value.startsWith('cache:')
						? { kind: 'named', name: value.slice('cache:'.length) }
						: value.startsWith('prefix:')
							? { kind: 'prefix', prefix: value.slice('prefix:'.length) }
							: undefined;
	const selector = reuseViewSelectorSchema.safeParse(candidate);

	if (!selector.success) {
		throw new InvalidReuseViewSelectorError(value);
	}

	return selector.data;
}

export function parsePriority(value: string): ReuseViewPriority {
	// Canonical decimal only: a leading zero is as non-canonical as hex or
	// exponent forms, so it is rejected the same way.
	if (!/^(?:0|[1-9]\d*)$/u.test(value)) {
		throw new InvalidReuseViewPriorityError(value);
	}

	const priority = Number(value);

	if (!Number.isSafeInteger(priority)) {
		throw new InvalidReuseViewPriorityError(value);
	}

	return reuseViewPrioritySchema.parse(priority);
}

// Exacts first, then prefixes, each in the order given: a deterministic
// rendering of whatever mix of repeatable flags the caller passed, regardless
// of how the two kinds were interleaved on the command line.
export function selectorsFromOptions(
	options: ReuseViewSetOptions
): ReuseViewSelector[] {
	if (options.select.length === 0) {
		throw new ReuseViewSelectorRequiredError();
	}

	return [...options.select];
}

export function registerReuseViewCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const reuseView = program
		.command('reuse-view')
		.description(
			'Manage named reuse views: sets of caches a reader may substitute from.'
		);

	reuseView
		.command('list')
		.description('List named reuse views.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.action(async (url: URL) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runReuseViewList(reporter, rpc.reuseViews);
		});

	reuseView
		.command('set')
		.description(
			'Define or replace a reuse view: its whole selector set is replaced on every call.'
		)
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'reuse-view name')
		.option(
			'--select <selector>',
			'default, all, all-named, cache:<name> or prefix:<prefix> (repeatable)',
			collectSelector,
			[]
		)
		.option(
			'--access <mode>',
			'read access: public or private (default: public)',
			parseCacheAccess
		)
		.option(
			'--priority <n>',
			'Nix substituter priority (lower is preferred); default 50',
			parsePriority
		)
		.addHelpText(
			'after',
			[
				'',
				'Examples:',
				'  # A view covering every PR cache plus one named release cache',
				'  cupboard reuse-view set https://cupboard.example.workers.dev/t/acme reuse \\',
				'    --select prefix:pr- --select cache:release',
				'',
				'  # A private view over private caches whose names start with pr-',
				'  cupboard reuse-view set https://cupboard.example.workers.dev/t/acme reuse \\',
				'    --access private --select prefix:pr-'
			].join('\n')
		)
		.action(async (url: URL, name: string, options: ReuseViewSetOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, {
					signal: programOptions.signal
				}),
				signal: programOptions.signal
			});

			await runReuseViewSet(
				name,
				options.access ?? 'public',
				selectorsFromOptions(options),
				options.priority,
				reporter,
				rpc.reuseViews
			);
		});

	reuseView
		.command('remove')
		.description('Remove a named reuse view.')
		.argument('<url>', tenantUrlArgument, parseWorkerUrl)
		.argument('<name>', 'reuse-view name')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: URL, name: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runReuseViewRemove(name, ui, rpc.reuseViews);
		});
}

export async function runReuseViewList(
	reporter: Reporter,
	client: Pick<ReuseViewClient, 'list'>
): Promise<void> {
	const { views } = await reporter.phase('Listing reuse views', () =>
		client.list()
	);

	reporter.result({
		kind: 'reuse-views',
		data: views,
		rows: views.map((view) => reuseViewRow(view)),
		empty: 'No reuse views.'
	});
}

export async function runReuseViewSet(
	name: string,
	access: CacheAccessMode,
	selectors: readonly ReuseViewSelector[],
	priority: ReuseViewPriority | undefined,
	reporter: Reporter,
	client: Pick<ReuseViewClient, 'set'>
): Promise<void> {
	const summary = await reporter.phase('Setting reuse view', () =>
		client.set({
			name,
			access,
			selectors: [...selectors],
			...(priority !== undefined && { priority })
		})
	);

	reporter.result({
		kind: 'reuse-view',
		data: summary,
		rows: [
			{ label: 'View', value: summary.name },
			{ label: 'Access', value: summary.access },
			{ label: 'Revision', value: String(summary.revision) },
			{ label: 'Priority', value: String(summary.priority) },
			{
				label: 'Selectors',
				value: summary.selectors
					.map((selector) => selectorLabel(selector))
					.join(', ')
			}
		]
	});
}

export async function runReuseViewRemove(
	name: string,
	ui: CliUi,
	client: Pick<ReuseViewClient, 'remove'>
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove reuse view ${name}?`,
		detail:
			'Clients can no longer query this view. The underlying caches are unchanged.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The reuse view was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Removing reuse view', () =>
		client.remove({ name })
	);

	reporter.result({
		kind: 'reuse-view',
		data: result,
		rows: [
			{ label: 'View', value: result.name },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
		]
	});
}

function reuseViewRow(view: ReuseViewSummary): ResultRow {
	const selectors = view.selectors
		.map((selector) => selectorLabel(selector))
		.join(', ');

	return {
		label: view.name,
		value: `${view.access}; revision ${String(view.revision)}; priority ${String(view.priority)}; ${selectors}`
	};
}

function selectorLabel(selector: ReuseViewSelector): string {
	if (selector.kind === 'default') {
		return 'default';
	}

	if (selector.kind === 'all') {
		return 'all';
	}

	if (selector.kind === 'named') {
		return `cache:${selector.name}`;
	}

	if (selector.kind === 'prefix') {
		return `prefix:${selector.prefix}`;
	}

	return 'all-named';
}
