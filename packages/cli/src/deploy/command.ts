import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';

import { CliError } from '../errors.ts';

import { buildArtifactFromTree, type DeploymentArtifact } from './artifact.ts';
import {
	type CredentialSource,
	defaultCredentialChain,
	resolveCloudflare
} from './auth.ts';
import { createEsbuildBundler } from './bundle.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import {
	deploymentPlanRows,
	type DeployOptions,
	runDeploy
} from './deploy-run.ts';
import { EmbeddedArtifactError, loadEmbeddedArtifact } from './embedded.ts';
import { assembleSecrets, generateWrapSecret } from './secrets.ts';
import { planWorkerSource } from './source.ts';
import { createDeployUi, type DeployUi } from './ui.ts';

/** The user backed out of a prompt; the deploy stops without error output. */
export class DeployCancelledError extends CliError {
	constructor() {
		super('Deploy cancelled');
		this.name = 'DeployCancelledError';
	}
}

/** A confirmation is needed but there is no terminal to ask on. */
export class ConfirmationRequiredError extends CliError {
	constructor() {
		super('Not running in a terminal: pass --yes to deploy without prompts.');
		this.name = 'ConfirmationRequiredError';
	}
}

/** An account must be chosen but there is no terminal to ask on. */
export class AccountOptionRequiredError extends CliError {
	constructor(accounts: readonly { id: string; name: string }[]) {
		super(
			'Several Cloudflare accounts are available; pass --account <id>:\n' +
				accounts.map((account) => `  ${account.id}  ${account.name}`).join('\n')
		);
		this.name = 'AccountOptionRequiredError';
	}
}

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
 * Settle on an account when the credential can see several: prompt when a
 * terminal is available, otherwise instruct the caller to pass `--account`.
 */
export async function chooseDeployAccount(
	ui: DeployUi,
	accounts: readonly { id: string; name: string }[],
	interactive: boolean
): Promise<string> {
	if (!interactive) {
		throw new AccountOptionRequiredError(accounts);
	}

	const chosen = await ui.chooseAccount(accounts);

	if (chosen === undefined) {
		throw new DeployCancelledError();
	}

	return chosen;
}

/**
 * Run `cupboard deploy`. Imported lazily by the command shell so its heavy
 * dependencies stay out of the released single-executable's startup path.
 *
 * The order is deliberate: build, authenticate, then show a complete plan
 * (account included) and ask once. Nothing interactive happens after the
 * confirmation, other than the deploy itself.
 */
export async function executeDeploy(
	cliOptions: DeployCliOptions
): Promise<void> {
	const ui = createDeployUi();
	const interactive = process.stdin.isTTY && process.stdout.isTTY;

	ui.intro();

	const { artifact, notice } = await ui
		.reporter()
		.phase('Building Workers', () =>
			resolveArtifact(cliOptions.fromTree ?? false)
		);

	if (notice !== undefined) {
		ui.info(notice);
	}

	const bucketName = bucketNameOf(artifact);

	const warnMissing = (missing: readonly string[]): void => {
		if (missing.length > 0) {
			ui.warn(
				`Missing secrets: ${missing.join(', ')}. ` +
					'The cache will not work until they are provided.'
			);
		}
	};

	if (cliOptions.dryRun === true) {
		const assembled = assembleSecrets({
			env: process.env,
			accountId: '',
			bucketName
		});

		ui.note(
			'Deployment plan',
			deploymentPlanRows(artifact, {
				domain: cliOptions.domain,
				dryRun: true,
				secrets: assembled.secrets
			})
		);
		warnMissing(assembled.missing);
		ui.outro('Dry run: nothing was changed.');
		return;
	}

	if (!interactive && cliOptions.yes !== true) {
		throw new ConfirmationRequiredError();
	}

	let api: CloudflareApi;
	let accountId: string;
	let credentialSource: CredentialSource;

	try {
		({ api, accountId, credentialSource } = await resolveCloudflare(
			cliOptions.account,
			(accounts) => chooseDeployAccount(ui, accounts, interactive),
			defaultCredentialChain({
				openBrowser: (url) => {
					ui.openBrowser(url);
				},
				wrangler: cliOptions.wrangler ?? true
			})
		));
	} catch (error) {
		if (error instanceof DeployCancelledError) {
			ui.cancelled('Deploy aborted.');
			return;
		}

		throw error;
	}

	ui.success(`Authenticated with Cloudflare (${credentialSource})`);

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
		const existing = await ui
			.reporter()
			.phase('Checking existing secrets', () =>
				api.listScriptSecrets(artifact.config.control.name)
			);
		missing = missing.filter((name) => name !== 'CONTROL_KEY_WRAP_SECRET');

		if (!existing.includes('CONTROL_KEY_WRAP_SECRET')) {
			const generated = generateWrapSecret();
			controlSecrets.push({ name: 'CONTROL_KEY_WRAP_SECRET', text: generated });
			ui.note('Generated CONTROL_KEY_WRAP_SECRET: save this value now', [
				{ label: 'Value', value: generated },
				{ label: 'Why', value: 'a different one cannot unwrap existing data' }
			]);
		}
	}

	const options: DeployOptions = {
		domain: cliOptions.domain,
		dryRun: false,
		secrets: { control: controlSecrets, tenant: assembled.secrets.tenant }
	};

	ui.note('Deployment plan', [
		{ label: 'Account', value: accountId },
		...deploymentPlanRows(artifact, options)
	]);
	warnMissing(missing);

	if (cliOptions.yes !== true && !(await ui.confirmDeploy())) {
		ui.cancelled('Deploy aborted.');
		return;
	}

	await runDeploy({ artifact, api, reporter: ui.reporter(), options });

	ui.outro(
		cliOptions.domain === undefined
			? 'Deployed.'
			: `Deployed: https://${cliOptions.domain}`
	);
}
