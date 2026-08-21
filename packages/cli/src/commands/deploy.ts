import {
	type InstanceName,
	instanceNameSchema
} from '@cupboard/protocol/instance';
import { type Command, InvalidArgumentError } from 'commander';

import { colourFromGlobals, type ProgramOptions } from '../cli.ts';
import type { DeployCliOptions } from '../deploy/command.ts';

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

export function registerDeployCommand(
	program: Command,
	programOptions: ProgramOptions = {}
): void {
	program
		.command('init')
		.alias('deploy')
		.description(
			'Provision, deploy and initialise this cupboard on a Cloudflare ' +
				'account, ready for nix.conf.'
		)
		.option('--domain <host>', 'custom domain to serve the cache on')
		.option(
			'--instance-name <name>',
			'name used in newly generated signing keys',
			parseInstanceName
		)
		.option('--account <id>', 'Cloudflare account id (otherwise resolved)')
		.option(
			'--no-wrangler',
			"do not use a logged-in wrangler's stored token; log in directly"
		)
		.option('--dry-run', 'show the plan without making any changes')
		.option('--from-tree', 'bundle the working tree even from a built binary')
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
