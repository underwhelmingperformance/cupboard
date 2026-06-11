import type { Command } from 'commander';

import type { DeployCliOptions } from '../deploy/command.ts';

export function registerDeployCommand(program: Command): void {
	program
		.command('deploy')
		.description('Provision and deploy this cupboard to a Cloudflare account.')
		.option('--domain <host>', 'custom domain to serve the cache on')
		.option('--account <id>', 'Cloudflare account id (otherwise resolved)')
		.option(
			'--no-wrangler',
			"do not use a logged-in wrangler's stored token; log in directly"
		)
		.option('--dry-run', 'show the plan without making any changes')
		.option('--from-tree', 'bundle the working tree even from a built binary')
		.option('--yes', 'skip the confirmation prompt')
		.action(async (cliOptions: DeployCliOptions) => {
			// Loaded on demand so the deploy stack (the Cloudflare SDK, esbuild) stays
			// out of the released binary's startup and the other commands' cost.
			const { executeDeploy } = await import('../deploy/command.ts');

			await executeDeploy(cliOptions);
		});
}
