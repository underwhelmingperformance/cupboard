import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';

import { createReporter } from '@cupboard/reporter';
import type { Command } from 'commander';

import { reporterModeFromGlobals } from '../cli.ts';
import {
	buildArtifactFromTree,
	type DeploymentArtifact
} from '../deploy/artifact.ts';
import { resolveCloudflare } from '../deploy/auth.ts';
import { createEsbuildBundler } from '../deploy/bundle.ts';
import {
	deploymentPlanRows,
	type DeployOptions,
	runDeploy
} from '../deploy/deploy-run.ts';
import { assembleSecrets } from '../deploy/secrets.ts';
import { planWorkerSource } from '../deploy/source.ts';

interface DeployCliOptions {
	readonly domain?: string;
	readonly account?: string;
	readonly dryRun?: boolean;
	readonly fromTree?: boolean;
	readonly yes?: boolean;
}

export class EmbeddedBundlesUnavailableError extends Error {
	constructor() {
		super(
			'This build has no embedded Workers. Run `cupboard deploy` from a checkout, or pass --from-tree.'
		);
		this.name = 'EmbeddedBundlesUnavailableError';
	}
}

function bucketNameOf(artifact: DeploymentArtifact): string {
	return artifact.config.tenant.r2Buckets[0]?.bucketName ?? 'cupboard-blobs';
}

async function resolveArtifact(
	fromTree: boolean
): Promise<{ artifact: DeploymentArtifact; notice: string | undefined }> {
	const plan = planWorkerSource({
		isSea: isSea(),
		cwd: process.cwd(),
		fromTree,
		fileExists: existsSync
	});

	if (plan.mode === 'embedded') {
		throw new EmbeddedBundlesUnavailableError();
	}

	if (plan.checkoutRoot === undefined) {
		throw new EmbeddedBundlesUnavailableError();
	}

	const artifact = await buildArtifactFromTree(
		plan.checkoutRoot,
		createEsbuildBundler()
	);

	return { artifact, notice: plan.notice };
}

export function registerDeployCommand(program: Command): void {
	program
		.command('deploy')
		.description('Provision and deploy this cupboard to a Cloudflare account.')
		.option('--domain <host>', 'custom domain to serve the cache on')
		.option('--account <id>', 'Cloudflare account id (otherwise resolved)')
		.option('--dry-run', 'show the plan without making any changes')
		.option('--from-tree', 'bundle the working tree even from a built binary')
		.option('--yes', 'skip the confirmation prompt')
		.action(async (cliOptions: DeployCliOptions) => {
			const reporter = createReporter({
				mode: reporterModeFromGlobals(program)
			});

			const { artifact, notice } = await reporter.phase(
				'Building Workers',
				() => resolveArtifact(cliOptions.fromTree ?? false)
			);

			if (notice !== undefined) {
				reporter.info(notice);
			}

			const bucketName = bucketNameOf(artifact);

			const warnMissing = (missing: readonly string[]): void => {
				if (missing.length > 0) {
					reporter.warn(
						'Missing secrets',
						`${missing.join(', ')} not set; the cache will not work until they are provided.`
					);
				}
			};

			const planRowsFor = (
				accountId: string
			): ReturnType<typeof deploymentPlanRows> => {
				const { secrets } = assembleSecrets({
					env: process.env,
					accountId,
					bucketName
				});

				return deploymentPlanRows(artifact, {
					domain: cliOptions.domain,
					dryRun: cliOptions.dryRun ?? false,
					secrets
				});
			};

			if (cliOptions.dryRun === true) {
				reporter.result(planRowsFor(''));
				warnMissing(
					assembleSecrets({ env: process.env, accountId: '', bucketName })
						.missing
				);
				return;
			}

			const { confirm, select } = await import('@inquirer/prompts');

			if (cliOptions.yes !== true) {
				reporter.result(planRowsFor(''));

				const proceed = await confirm({
					message: 'Deploy to Cloudflare with the plan above?',
					default: false
				});

				if (!proceed) {
					reporter.info('Aborted.');
					return;
				}
			}

			const { api, accountId } = await resolveCloudflare(
				cliOptions.account,
				(accounts) =>
					select({
						message: 'Which Cloudflare account?',
						choices: accounts.map((account) => ({
							name: `${account.name} (${account.id})`,
							value: account.id
						}))
					})
			);

			const { secrets, missing } = assembleSecrets({
				env: process.env,
				accountId,
				bucketName
			});
			warnMissing(missing);

			const options: DeployOptions = {
				domain: cliOptions.domain,
				dryRun: false,
				secrets
			};

			await runDeploy({ artifact, api, reporter, options });
		});
}
