import { type CliUi, createCliUi } from '@cupboard/cli-ui';
import type {
	OidcTrustAddBody,
	OidcTrustListResponse,
	OidcTrustRemoveResponse,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';
import {
	createReporter,
	type Reporter,
	type ResultRow
} from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { type ProgramOptions, reporterModeFromGlobals } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { InvalidClaimError } from '../errors.ts';

interface ConfirmableOptions {
	readonly yes?: boolean;
}

interface OidcTrustAddOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly claim: readonly string[];
	readonly allowedRoot: readonly string[];
}

/**
 * The slice of the derived client the trust commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).oidcTrust`
 * satisfies it by construction.
 */
export interface OidcTrustClient {
	list(): Promise<OidcTrustListResponse>;
	add(input: OidcTrustAddBody): Promise<OidcTrustSummary>;
	remove(input: { id: string }): Promise<OidcTrustRemoveResponse>;
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

function parseClaims(pairs: readonly string[]): Record<string, string> {
	const claims: Record<string, string> = {};

	for (const pair of pairs) {
		const separator = pair.indexOf('=');

		if (separator <= 0) {
			throw new InvalidClaimError(pair);
		}

		claims[pair.slice(0, separator)] = pair.slice(separator + 1);
	}

	return claims;
}

export function registerOidcTrustCommands(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	const oidcTrust = program
		.command('oidc-trust')
		.description('Manage the CI write-trust rules used by token exchange.');

	oidcTrust
		.command('list')
		.description('List OIDC trust rules.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.action(async (url: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runOidcTrustList(reporter, rpc.oidcTrust);
		});

	oidcTrust
		.command('add')
		.description('Add a write-trust rule for a CI OIDC issuer.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.requiredOption('--issuer <issuer>', 'OIDC issuer URL')
		.requiredOption('--audience <audience>', 'expected token audience')
		.option(
			'--claim <key=value>',
			'a claim the token must match exactly (repeatable)',
			collect,
			[]
		)
		.option(
			'--allowed-root <name>',
			'a root name or prefix the rule may write (repeatable)',
			collect,
			[]
		)
		.action(async (url: string, options: OidcTrustAddOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});
			const body: OidcTrustAddBody = {
				issuer: options.issuer,
				audience: options.audience,
				claims: parseClaims(options.claim),
				allowedRoots: [...options.allowedRoot]
			};

			await runOidcTrustAdd(body, reporter, rpc.oidcTrust);
		});

	oidcTrust
		.command('remove')
		.description('Disable an OIDC trust rule by id.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<id>', 'trust rule id')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: string, id: string, options: ConfirmableOptions) => {
			const ui = createCliUi({
				mode: reporterModeFromGlobals(program),
				assumeYes: options.yes
			});
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runOidcTrustRemove(id, ui, rpc.oidcTrust);
		});
}

export async function runOidcTrustList(
	reporter: Reporter,
	client: OidcTrustClient
): Promise<void> {
	const { rules } = await reporter.phase('Listing OIDC trust rules', () =>
		client.list()
	);

	if (rules.length === 0) {
		reporter.info('No OIDC trust rules.');
		return;
	}

	reporter.result({
		kind: 'oidc-trust-rules',
		data: rules,
		rows: rules.map((rule) => trustRow(rule))
	});
}

export async function runOidcTrustAdd(
	body: OidcTrustAddBody,
	reporter: Reporter,
	client: OidcTrustClient
): Promise<void> {
	const summary = await reporter.phase('Adding OIDC trust rule', () =>
		client.add(body)
	);

	reporter.result({
		kind: 'oidc-trust-rule',
		data: summary,
		rows: [
			{ label: 'Rule', value: summary.id },
			{ label: 'Issuer', value: summary.issuer },
			{ label: 'Audience', value: summary.audience },
			{ label: 'Scope', value: summary.scope },
			{
				label: 'Allowed roots',
				value: summary.allowedRoots.join(', ') || '(none)'
			}
		]
	});
}

export async function runOidcTrustRemove(
	id: string,
	ui: CliUi,
	client: OidcTrustClient
): Promise<void> {
	const outcome = await ui.confirm({
		message: `Remove OIDC trust rule ${id}?`,
		detail: 'CI workflows relying on this rule can no longer exchange tokens.'
	});

	if (outcome !== 'yes') {
		ui.cancelled('The trust rule was left in place.');
		return;
	}

	const reporter = ui.reporter();
	const result = await reporter.phase('Removing OIDC trust rule', () =>
		client.remove({ id })
	);

	reporter.result({
		kind: 'oidc-trust-rule',
		data: result,
		rows: [
			{ label: 'Rule', value: result.id },
			{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
		]
	});
}

function trustRow(rule: OidcTrustSummary): ResultRow {
	const state = rule.disabled ? ' (disabled)' : '';

	return {
		label: rule.id,
		value: `${rule.scope} ${rule.issuer} aud=${rule.audience}${state}`
	};
}
