import type { CliUi } from '@cupboard/cli-ui';
import type {
	OidcTrustAddBody,
	OidcTrustListResponse,
	OidcTrustRemoveResponse,
	OidcTrustSummary
} from '@cupboard/protocol/oidc';
import { type Reporter, type ResultRow } from '@cupboard/reporter';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth/auth.ts';
import { commandUi, type ProgramOptions } from '../cli.ts';
import { tenantRpc } from '../client/orpc.ts';
import { InvalidClaimError } from '../errors.ts';
import { tenantUrlArgument } from '../url-argument.ts';

import { buildAddBody, buildCacheGrant } from './oidc-trust/rule-builder.ts';

interface ConfirmableOptions {
	readonly yes?: boolean;
}

interface OidcTrustAddOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly claim: readonly string[];
	readonly allow: readonly string[];
	readonly cache?: string;
	readonly root?: string;
}

/**
 * The slice of the derived client the trust commands consume, in the
 * contract's input and output shapes; the real `tenantRpc(...).oidcTrust`
 * satisfies it by construction.
 */
export interface OidcTrustClient {
	list(): Promise<OidcTrustListResponse>;
	get(input: { id: string }): Promise<OidcTrustSummary>;
	add(input: OidcTrustAddBody): Promise<OidcTrustSummary>;
	remove(input: { id: string }): Promise<OidcTrustRemoveResponse>;
}

function collect(value: string, previous: readonly string[]): string[] {
	return [...previous, value];
}

function claimRows(claims: Record<string, string>): ResultRow[] {
	const entries = Object.entries(claims);

	if (entries.length === 0) {
		return [{ label: 'Claims', value: '(none)' }];
	}

	return entries.map(([key, value], index) => ({
		label: index === 0 ? 'Claims' : '',
		value: `${key}=${value}`
	}));
}

function grantRows(grants: OidcTrustSummary['permittedGrants']): ResultRow[] {
	if (grants.length === 0) {
		return [{ label: 'Grants', value: '(none)' }];
	}

	return grants.map((grant, index) => ({
		label: index === 0 ? 'Grants' : '',
		value: describeGrant(grant)
	}));
}

function describeGrant(
	grant: OidcTrustSummary['permittedGrants'][number]
): string {
	if (grant.type === 'cupboard_wildcard') {
		return 'wildcard (every operation)';
	}

	if (grant.type === 'cupboard_cache') {
		const cache =
			grant.resources.cache.exact ?? grant.resources.cache.equalsTemplate;

		return `cache ${cache ?? '?'}: ${grant.actions.join(', ')}`;
	}

	if (grant.type === 'cupboard_tenant') {
		const tenant =
			grant.resources.tenant.exact ?? grant.resources.tenant.equalsTemplate;

		return `tenant ${tenant ?? '?'}: ${grant.actions.join(', ')}`;
	}

	return `${grant.type}: ${grant.actions.join(', ')}`;
}

function summaryRows(summary: OidcTrustSummary): ResultRow[] {
	return [
		{ label: 'Rule', value: summary.id },
		{ label: 'Issuer', value: summary.issuer },
		{ label: 'Audience', value: summary.audience },
		...claimRows(summary.claims),
		...grantRows(summary.permittedGrants),
		...(summary.display?.repository === undefined
			? []
			: [{ label: 'Repository', value: summary.display.repository }])
	];
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
		.argument('<url>', tenantUrlArgument)
		.action(async (url: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runOidcTrustList(reporter, rpc.oidcTrust);
		});

	oidcTrust
		.command('show')
		.description('Show a single OIDC trust rule by id.')
		.argument('<url>', tenantUrlArgument)
		.argument('<id>', 'trust rule id')
		.action(async (url: string, id: string) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runOidcTrustShow(id, reporter, rpc.oidcTrust);
		});

	oidcTrust
		.command('add')
		.description('Add a write-trust rule for a CI OIDC issuer.')
		.argument('<url>', tenantUrlArgument)
		.requiredOption('--issuer <issuer>', 'OIDC issuer URL')
		.requiredOption('--audience <audience>', 'expected token audience')
		.option(
			'--claim <key=value>',
			'a claim the token must match exactly (repeatable)',
			collect,
			[]
		)
		.option(
			'--allow <action>',
			'an action set the rule may exchange for: push, attest, or root (repeatable)',
			collect,
			[]
		)
		.option('--cache <name>', 'the cache the grant is scoped to')
		.option(
			'--root <name>',
			'a root the grant may set, or "same-as-cache" to tie it to the cache'
		)
		.addHelpText(
			'after',
			[
				'',
				'Example:',
				'  # Trust a specific reusable workflow to push to a cache,',
				'  # keyed on the job_workflow_ref claim',
				'  cupboard oidc-trust add https://cupboard.example.workers.dev/t/acme \\',
				'    --issuer https://token.actions.githubusercontent.com \\',
				'    --audience https://cupboard.example.workers.dev/t/acme \\',
				'    --claim job_workflow_ref=acme/ci/.github/workflows/push.yml@refs/heads/main \\',
				'    --allow push --allow root --cache acme-ci --root same-as-cache'
			].join('\n')
		)
		.action(async (url: string, options: OidcTrustAddOptions) => {
			const reporter = commandUi(program, programOptions).reporter();
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});
			const body = buildAddBody({
				issuer: options.issuer,
				audience: options.audience,
				claims: parseClaims(options.claim),
				permittedGrants: [
					buildCacheGrant({
						cache: options.cache,
						allow: options.allow,
						root: options.root
					})
				]
			});

			await runOidcTrustAdd(body, reporter, rpc.oidcTrust);
		});

	oidcTrust
		.command('remove')
		.description('Disable an OIDC trust rule by id.')
		.argument('<url>', tenantUrlArgument)
		.argument('<id>', 'trust rule id')
		.option('-y, --yes', 'remove without the confirmation prompt')
		.action(async (url: string, id: string, options: ConfirmableOptions) => {
			const ui = commandUi(program, programOptions, { assumeYes: options.yes });
			const rpc = tenantRpc(url, {
				credential: cachedOwnerProvider(url, { signal: programOptions.signal }),
				signal: programOptions.signal
			});

			await runOidcTrustRemove(id, ui, rpc.oidcTrust);
		});
}

export async function runOidcTrustList(
	reporter: Reporter,
	client: Pick<OidcTrustClient, 'list'>
): Promise<void> {
	const { rules } = await reporter.phase('Listing OIDC trust rules', () =>
		client.list()
	);

	reporter.result({
		kind: 'oidc-trust-rules',
		data: rules,
		rows: rules.map((rule) => trustRow(rule)),
		empty: 'No OIDC trust rules.'
	});
}

export async function runOidcTrustAdd(
	body: OidcTrustAddBody,
	reporter: Reporter,
	client: Pick<OidcTrustClient, 'add'>
): Promise<void> {
	const summary = await reporter.phase('Adding OIDC trust rule', () =>
		client.add(body)
	);

	reporter.result({
		kind: 'oidc-trust-rule',
		data: summary,
		rows: summaryRows(summary)
	});
}

export async function runOidcTrustShow(
	id: string,
	reporter: Reporter,
	client: Pick<OidcTrustClient, 'get'>
): Promise<void> {
	const summary = await reporter.phase('Fetching OIDC trust rule', () =>
		client.get({ id })
	);

	reporter.result({
		kind: 'oidc-trust-rule',
		data: summary,
		rows: summaryRows(summary)
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
	const grants = rule.permittedGrants.some(
		(grant) => grant.type === 'cupboard_wildcard'
	)
		? 'wildcard'
		: `${String(rule.permittedGrants.length)} grant(s)`;

	return {
		label: rule.id,
		value: `${grants} ${rule.issuer} aud=${rule.audience}${state}`
	};
}
