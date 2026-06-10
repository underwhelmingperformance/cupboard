import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';

import { createReporter, type ReporterMode } from '@cupboard/reporter';

import { buildArtifactFromTree, type DeploymentArtifact } from './artifact.ts';
import { resolveCloudflare } from './auth.ts';
import { createEsbuildBundler } from './bundle.ts';
import {
	deploymentPlanRows,
	type DeployOptions,
	runDeploy
} from './deploy-run.ts';
import { EmbeddedArtifactError, loadEmbeddedArtifact } from './embedded.ts';
import { assembleSecrets } from './secrets.ts';
import { planWorkerSource } from './source.ts';

export interface DeployCliOptions {
	readonly domain?: string;
	readonly account?: string;
	readonly dryRun?: boolean;
	readonly fromTree?: boolean;
	readonly yes?: boolean;
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
		return { artifact: loadEmbeddedArtifact(), notice: plan.notice };
	}

	if (plan.checkoutRoot === undefined) {
		throw new EmbeddedArtifactError('no checkout found');
	}

	const artifact = await buildArtifactFromTree(
		plan.checkoutRoot,
		createEsbuildBundler()
	);

	return { artifact, notice: plan.notice };
}

/**
 * Run `cupboard deploy`. Imported lazily by the command shell so its heavy
 * dependencies stay out of the released single-executable's startup path.
 */
export async function executeDeploy(
	cliOptions: DeployCliOptions,
	reporterMode: ReporterMode | undefined
): Promise<void> {
	const reporter = createReporter({ mode: reporterMode });

	const { artifact, notice } = await reporter.phase('Building Workers', () =>
		resolveArtifact(cliOptions.fromTree ?? false)
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
			assembleSecrets({ env: process.env, accountId: '', bucketName }).missing
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
}
