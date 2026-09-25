import { cacheNameSchema } from '@cupboard/nix-store/scalars';
import {
	type InstanceName,
	instanceNameSchema
} from '@cupboard/protocol/instance';
import { type Command, InvalidArgumentError } from 'commander';

import { parseAudience } from '../audience.ts';
import { parseCacheAccess } from '../cache-access.ts';
import { colourFromGlobals, type ProgramOptions } from '../cli.ts';
import { cloudflareOauthClientId } from '../deploy/cloudflare-oauth.ts';
import type { DeployCliOptions } from '../deploy/command.ts';
import { cloudflareDashIssuer } from '../deploy/owner.ts';
import type { WorkersPlanOverride } from '../deploy/workers-plan.ts';

function parseWorkersPlan(value: string): WorkersPlanOverride {
	if (value !== 'free' && value !== 'paid') {
		throw new InvalidArgumentError('Workers plan must be free or paid.');
	}

	return value;
}

function parseInstanceName(value: string): InstanceName {
	const parsed = instanceNameSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidArgumentError(
			'Instance name must contain only lower-case letters, digits and internal ' +
				'hyphens, and must be at most 63 characters long.'
		);
	}

	return parsed.data;
}

function parseCacheSlug(value: string): string {
	if (!cacheNameSchema.safeParse(value).success) {
		throw new InvalidArgumentError(
			'Tenant slug must use lowercase letters, digits, ".", "_" or "-", ' +
				'starting with a letter or digit (63 characters at most).'
		);
	}

	return value;
}

export function registerDeployCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('init')
		.alias('deploy')
		.description(
			'Deploy cupboard to a Cloudflare account, or upgrade an existing ' +
				'deployment.'
		)
		.option('--domain <host>', 'custom domain to serve the cache on')
		.option(
			'--instance-name <name>',
			"the first part of every signing key's name, such as cupboard in cupboard-acme-1",
			parseInstanceName
		)
		.option(
			'--account <id>',
			'Cloudflare account ID (by default, the only account you can access, or the one you choose)'
		)
		.option(
			'--cache <slug>',
			'slug of the first tenant on a new deployment (you are asked if you ' +
				'leave it out; without a terminal, no tenant is created)',
			parseCacheSlug
		)
		.option(
			'--access <mode>',
			"read access for the first tenant's default cache: public or " +
				'private (you are asked if you leave it out)',
			parseCacheAccess
		)
		.option(
			'--oidc-issuer <issuer>',
			'OIDC issuer of the identity that claims a new deployment as its admin',
			cloudflareDashIssuer
		)
		.option(
			'--client-id <id>',
			"the public OAuth client ID to sign in as the admin with, on a first deploy, and on an update when the database does not record the admin's client (PKCE, no client secret)",
			cloudflareOauthClientId
		)
		.option(
			'--headless',
			'sign in as the admin with a code in a browser on another device, instead of opening one here, on a first deploy or when an update signs you in as the admin. Signing in to Cloudflare for the account can still open a browser.'
		)
		.option(
			'--github-oidc',
			"authorise an update with the workflow's GitHub Actions OIDC token, " +
				'through a control trust rule, instead of a `cupboard login` session'
		)
		.option(
			'--audience <audience>',
			'OIDC audience to request with --github-oidc (default: the deployment URL)',
			parseAudience
		)
		.option(
			'--no-wrangler',
			"sign in to Cloudflare in the browser instead of using wrangler's stored token"
		)
		.option(
			'--workers-plan <plan>',
			"your account's Workers plan, free or paid, which sets cupboard's limit on calls to other Cloudflare services (by default, looked up from the account)",
			parseWorkersPlan
		)
		.option(
			'--dry-run',
			'show what would be deployed without changing anything'
		)
		.option(
			'--from-tree',
			'when the released binary runs inside a cupboard checkout, deploy Workers built from the working tree instead of the embedded ones'
		)
		.option('-y, --yes', 'skip the confirmation prompt')
		.action(async (cliOptions: DeployCliOptions) => {
			// Loaded on demand so the deploy stack (the Cloudflare SDK, esbuild) stays
			// out of the released binary's startup and the other commands' cost.
			const { executeDeploy } = await import('../deploy/command.ts');

			await executeDeploy(cliOptions, {
				signal: programOptions.signal,
				colour: colourFromGlobals(program)
			});
		});
}
