import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';

import { createReporter, type ReporterMode } from '@cupboard/reporter';

import { openBrowser } from '../io/open-browser.ts';

import { buildArtifactFromTree, type DeploymentArtifact } from './artifact.ts';
import { defaultCredentialChain, resolveCloudflare } from './auth.ts';
import { createEsbuildBundler } from './bundle.ts';
import {
	deploymentPlanRows,
	type DeployOptions,
	runDeploy
} from './deploy-run.ts';
import { EmbeddedArtifactError, loadEmbeddedArtifact } from './embedded.ts';
import { assembleSecrets, generateWrapSecret } from './secrets.ts';
import { planWorkerSource } from './source.ts';

export interface DeployCliOptions {
	readonly domain?: string;
	readonly account?: string;
	readonly dryRun?: boolean;
	readonly fromTree?: boolean;
	readonly yes?: boolean;
	/** False when `--no-wrangler` was passed; absent means allowed. */
	readonly wrangler?: boolean;
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

	const { api, accountId, credentialSource } = await resolveCloudflare(
		cliOptions.account,
		(accounts) =>
			select({
				message: 'Which Cloudflare account?',
				choices: accounts.map((account) => ({
					name: `${account.name} (${account.id})`,
					value: account.id
				}))
			}),
		defaultCredentialChain({
			openBrowser: (url) => {
				openBrowser(url, reporter);
			},
			wrangler: cliOptions.wrangler ?? true
		})
	);

	reporter.info(`Using Cloudflare credentials from: ${credentialSource}`);

	const assembled = assembleSecrets({
		env: process.env,
		accountId,
		bucketName
	});
	const controlSecrets = [...assembled.secrets.control];
	let missing = assembled.missing;

	// Generate the control key wrapping secret on a first deploy, but never
	// overwrite an existing one: a different value cannot unwrap stored data.
	if (missing.includes('CONTROL_KEY_WRAP_SECRET')) {
		const existing = await api.listScriptSecrets(artifact.config.control.name);
		missing = missing.filter((name) => name !== 'CONTROL_KEY_WRAP_SECRET');

		if (!existing.includes('CONTROL_KEY_WRAP_SECRET')) {
			const generated = generateWrapSecret();
			controlSecrets.push({ name: 'CONTROL_KEY_WRAP_SECRET', text: generated });
			reporter.warn(
				'Generated CONTROL_KEY_WRAP_SECRET',
				`save this value now; a different one cannot unwrap existing data:\n${generated}`
			);
		}
	}

	warnMissing(missing);

	const options: DeployOptions = {
		domain: cliOptions.domain,
		dryRun: false,
		secrets: { control: controlSecrets, tenant: assembled.secrets.tenant }
	};

	await runDeploy({ artifact, api, reporter, options });
}
