import type {
	OidcTrustAddBody,
	OidcTrustListResponse,
	OidcTrustRemoveResponse,
	OidcTrustSummary
} from '@cupboard/shared';
import type { Command } from 'commander';

import { cachedOwnerProvider } from '../auth.ts';
import { reporterModeFromGlobals } from '../cli.ts';
import { type AccessCredential, CupboardClient } from '../client.ts';
import { InvalidClaimError } from '../errors.ts';
import { createReporter, type Reporter, type ResultRow } from '../reporter.ts';

interface OidcTrustAddOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly claim: readonly string[];
	readonly allowedRoot: readonly string[];
}

export interface OidcTrustClient {
	listOidcTrust(token: AccessCredential): Promise<OidcTrustListResponse>;
	addOidcTrust(
		token: AccessCredential,
		body: OidcTrustAddBody
	): Promise<OidcTrustSummary>;
	removeOidcTrust(
		token: AccessCredential,
		id: string
	): Promise<OidcTrustRemoveResponse>;
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

export function registerOidcTrustCommands(program: Command): void {
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
			const client = CupboardClient.fromUrl(url);

			await runOidcTrustList(cachedOwnerProvider(), reporter, client);
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
			const client = CupboardClient.fromUrl(url);
			const body: OidcTrustAddBody = {
				issuer: options.issuer,
				audience: options.audience,
				claims: parseClaims(options.claim),
				allowedRoots: [...options.allowedRoot]
			};

			await runOidcTrustAdd(body, cachedOwnerProvider(), reporter, client);
		});

	oidcTrust
		.command('remove')
		.description('Disable an OIDC trust rule by id.')
		.argument('<url>', 'Worker URL (e.g. https://cupboard.example.workers.dev)')
		.argument('<id>', 'trust rule id')
		.action(async (url: string, id: string) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});
			const client = CupboardClient.fromUrl(url);

			await runOidcTrustRemove(id, cachedOwnerProvider(), reporter, client);
		});
}

export async function runOidcTrustList(
	token: AccessCredential,
	reporter: Reporter,
	client: OidcTrustClient
): Promise<void> {
	const { rules } = await reporter.phase('Listing OIDC trust rules', () =>
		client.listOidcTrust(token)
	);

	if (rules.length === 0) {
		reporter.info('No OIDC trust rules.');
		return;
	}

	reporter.result(rules.map((rule) => trustRow(rule)));
}

export async function runOidcTrustAdd(
	body: OidcTrustAddBody,
	token: AccessCredential,
	reporter: Reporter,
	client: OidcTrustClient
): Promise<void> {
	const summary = await reporter.phase('Adding OIDC trust rule', () =>
		client.addOidcTrust(token, body)
	);

	reporter.result([
		{ label: 'Rule', value: summary.id },
		{ label: 'Issuer', value: summary.issuer },
		{ label: 'Audience', value: summary.audience },
		{ label: 'Scope', value: summary.scope },
		{
			label: 'Allowed roots',
			value: summary.allowedRoots.join(', ') || '(none)'
		}
	]);
}

export async function runOidcTrustRemove(
	id: string,
	token: AccessCredential,
	reporter: Reporter,
	client: OidcTrustClient
): Promise<void> {
	const result = await reporter.phase('Removing OIDC trust rule', () =>
		client.removeOidcTrust(token, id)
	);

	reporter.result([
		{ label: 'Rule', value: result.id },
		{ label: 'Removed', value: result.removed ? 'yes' : 'not present' }
	]);
}

function trustRow(rule: OidcTrustSummary): ResultRow {
	const state = rule.disabled ? ' (disabled)' : '';

	return {
		label: rule.id,
		value: `${rule.scope} ${rule.issuer} aud=${rule.audience}${state}`
	};
}
