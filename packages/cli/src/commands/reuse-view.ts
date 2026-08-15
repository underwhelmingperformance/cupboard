import type { CliUi } from '@cupboard/cli-ui';
import {
	type ParsedReuseViewListResponse,
	type ParsedReuseViewRemoveResponse,
	type ParsedReuseViewSummary,
	type ReuseViewPriority,
	reuseViewPrioritySchema,
	type ReuseViewSelector,
	type ReuseViewSummary
} from '@cupboard/protocol/reuse-views';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	InvalidReuseViewPriorityError,
	ReuseViewSelectorRequiredError
} from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

export interface ReuseViewSetOptions {
	readonly exact: readonly string[];
	readonly prefix: readonly string[];
	readonly priority?: ReuseViewPriority;
}

interface ConfirmableOptions {
	readonly yes?: boolean;
}

/**
 * The part of the derived client that the reuse-view commands use, in the
 * contract's input and output shapes. The real `tenantRpc(...).reuseViews`
 * satisfies this interface by construction.
 */
export interface ReuseViewClient {
	list(): Promise<ParsedReuseViewListResponse>;
	set(input: {
		name: string;
		selectors: readonly ReuseViewSelector[];
		priority?: number;
	}): Promise<ParsedReuseViewSummary>;
	remove(input: { name: string }): Promise<ParsedReuseViewRemoveResponse>;
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
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
	if (options.exact.length === 0 && options.prefix.length === 0) {
		throw new ReuseViewSelectorRequiredError();
	}

	return [
		...options.exact.map((pattern) => ({ kind: 'exact' as const, pattern })),
		...options.prefix.map((pattern) => ({ kind: 'prefix' as const, pattern }))
	];
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
			'--exact <cache>',
			'an exact cache name to include (repeatable)',
			collect,
			[]
		)
		.option(
			'--prefix <prefix>',
			"a cache-name prefix to include (repeatable); '' matches every cache",
			collect,
			[]
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
				'Example:',
				'  # A view covering every PR cache plus one named release cache',
				'  cupboard reuse-view set https://cupboard.example.workers.dev/t/acme reuse \\',
				'    --prefix pr- --exact release'
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
	selectors: readonly ReuseViewSelector[],
	priority: ReuseViewPriority | undefined,
	reporter: Reporter,
	client: Pick<ReuseViewClient, 'set'>
): Promise<void> {
	const summary = await reporter.phase('Setting reuse view', () =>
		client.set({ name, selectors, ...(priority !== undefined && { priority }) })
	);

	reporter.result({
		kind: 'reuse-view',
		data: summary,
		rows: [
			{ label: 'View', value: summary.name },
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
		detail: 'Caches that substitute from this view lose it immediately.'
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
		value: `revision ${String(view.revision)}; priority ${String(view.priority)}; ${selectors}`
	};
}

function selectorLabel(selector: ReuseViewSelector): string {
	if (selector.kind === 'exact') {
		return `exact:${selector.pattern}`;
	}

	return `prefix:${selector.pattern === '' ? '(all caches)' : selector.pattern}`;
}
