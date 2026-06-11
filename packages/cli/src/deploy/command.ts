import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';

import type Cloudflare from 'cloudflare';

import { CliError } from '../errors.ts';

import { buildArtifactFromTree, type DeploymentArtifact } from './artifact.ts';
import {
	type CredentialSource,
	defaultCredentialChain,
	resolveCloudflare
} from './auth.ts';
import { createEsbuildBundler } from './bundle.ts';
import { type CloudflareApi, createCloudflareApi } from './cloudflare-api.ts';
import {
	cronProblem,
	type DeploymentConfig,
	type EditableResourceKind,
	resourceNameProblem
} from './config.ts';
import {
	choicePlanRows,
	collectResources,
	type DeployOptions,
	derivedPlanRows,
	runDeploy
} from './deploy-run.ts';
import { checkDomainOption, domainProblem } from './domain.ts';
import { EmbeddedArtifactError, loadEmbeddedArtifact } from './embedded.ts';
import { renameResource, withCrons } from './overrides.ts';
import {
	accessKeyIdProblem,
	checkR2Credentials,
	type R2Credentials,
	secretAccessKeyProblem
} from './r2-credentials.ts';
import { assembleSecrets, generateWrapSecret } from './secrets.ts';
import { planWorkerSource } from './source.ts';
import { createDeployUi, type DeployUi, type MenuEntry } from './ui.ts';

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

/** R2 credentials are needed but there is no terminal to ask on. */
export class R2CredentialsRequiredError extends CliError {
	constructor() {
		super(
			'R2 credentials are required: set R2_ACCESS_KEY_ID and ' +
				'R2_SECRET_ACCESS_KEY (an R2 API token scoped to the cache bucket).'
		);
		this.name = 'R2CredentialsRequiredError';
	}
}

/** R2 could not be reached to probe the credential pair. */
export class R2UnreachableError extends CliError {
	constructor(options: { readonly cause: unknown }) {
		super('Could not reach R2 to check the credentials', options);
		this.name = 'R2UnreachableError';
	}
}

/** R2 rejected the credential pair when probed. */
export class R2CredentialsRejectedError extends CliError {
	constructor(public readonly status: number) {
		super(
			`R2 rejected the credentials (HTTP ${String(status)}). ` +
				'Check the access key id and secret, and that the token may read ' +
				'and write the cache bucket.'
		);
		this.name = 'R2CredentialsRejectedError';
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

function bucketNameOf(config: DeploymentConfig): string {
	return config.tenant.r2Buckets[0]?.bucketName ?? 'cupboard-blobs';
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

/** The deploy-time choices the user may tweak while reviewing the plan. */
export interface PlanState {
	readonly accountId: string;
	readonly domain: string | undefined;
	readonly config: DeploymentConfig;
}

type ResourceChoice = `${EditableResourceKind}:${string}`;
type PlanChoice =
	| 'deploy'
	| 'account'
	| 'domain'
	| 'crons'
	| 'cancel'
	| ResourceChoice;

const resourceLabels: Record<EditableResourceKind, string> = {
	bucket: 'R2 bucket',
	database: 'D1 database',
	queue: 'Queue'
};

/**
 * The review menu: Deploy first (so plain Enter accepts the plan as shown),
 * then one entry per editable value with its current setting, then Cancel.
 */
export function planMenuEntries(state: PlanState): MenuEntry<PlanChoice>[] {
	const resources = collectResources(state.config);
	const resourceEntries = (
		kind: EditableResourceKind,
		names: readonly string[]
	): MenuEntry<PlanChoice>[] =>
		names.map((name) => ({
			value: `${kind}:${name}`,
			label: resourceLabels[kind],
			hint: name
		}));

	return [
		{ value: 'deploy', label: 'Deploy' },
		{ value: 'account', label: 'Account', hint: state.accountId },
		{
			value: 'domain',
			label: 'Custom domain',
			hint: state.domain ?? '(none)'
		},
		...resourceEntries('bucket', resources.r2Buckets),
		...resourceEntries('database', resources.d1Databases),
		...resourceEntries('queue', resources.queues),
		{
			value: 'crons',
			label: 'Cron triggers',
			hint: state.config.control.crons.join(', ') || '(none)'
		},
		{ value: 'cancel', label: 'Cancel' }
	];
}

function cronsListProblem(value: string): string | undefined {
	for (const part of value.split(',').map((cron) => cron.trim())) {
		const problem = cronProblem(part);

		if (problem !== undefined) {
			return `${part}: ${problem}`;
		}
	}

	return undefined;
}

export interface PlanReviewWorld {
	readonly ui: DeployUi;
	readonly render: (state: PlanState) => Promise<void>;
	readonly accounts: () => Promise<readonly { id: string; name: string }[]>;
	/** True when `--yes` accepted the plan up front. */
	readonly skipReview: boolean;
}

async function applyPlanEdit(
	state: PlanState,
	choice: Exclude<PlanChoice, 'deploy' | 'cancel'>,
	world: PlanReviewWorld
): Promise<PlanState> {
	const { ui } = world;

	if (choice === 'account') {
		const chosen = await ui.chooseAccount(await world.accounts());

		return chosen === undefined ? state : { ...state, accountId: chosen };
	}

	if (choice === 'domain') {
		const edit = await ui.editText({
			message: 'Custom domain to serve the cache on (empty for none)',
			initial: state.domain,
			placeholder: 'cache.example.com',
			emptyClears: true,
			problem: domainProblem
		});

		if (edit.kind === 'set') {
			return { ...state, domain: edit.value };
		}

		return edit.kind === 'clear' ? { ...state, domain: undefined } : state;
	}

	if (choice === 'crons') {
		const edit = await ui.editText({
			message: 'Cron triggers, comma separated (empty for none)',
			initial: state.config.control.crons.join(', '),
			placeholder: '0 * * * *',
			emptyClears: true,
			problem: cronsListProblem
		});

		if (edit.kind === 'set') {
			const crons = edit.value.split(',').map((cron) => cron.trim());

			return { ...state, config: withCrons(state.config, crons) };
		}

		return edit.kind === 'clear'
			? { ...state, config: withCrons(state.config, []) }
			: state;
	}

	const separator = choice.indexOf(':');
	const kind = choice.slice(0, separator);
	const name = choice.slice(separator + 1);

	if (kind !== 'bucket' && kind !== 'database' && kind !== 'queue') {
		return state;
	}

	const edit = await ui.editText({
		message: `Rename ${resourceLabels[kind]} ${name} to`,
		initial: name,
		problem: (value) => resourceNameProblem(kind, value)
	});

	if (edit.kind !== 'set' || edit.value === name) {
		return state;
	}

	return {
		...state,
		config: renameResource(state.config, kind, name, edit.value)
	};
}

/**
 * Show the plan and let the user adjust the deploy-time choices until they
 * deploy or cancel. Returns the agreed state, or undefined when cancelled.
 */
export async function reviewPlan(
	initial: PlanState,
	world: PlanReviewWorld
): Promise<PlanState | undefined> {
	let state = initial;

	for (;;) {
		await world.render(state);

		if (world.skipReview) {
			return state;
		}

		const choice = await world.ui.menu(
			'Deploy to Cloudflare with the plan above?',
			planMenuEntries(state)
		);

		if (choice === undefined || choice === 'cancel') {
			return undefined;
		}

		if (choice === 'deploy') {
			return state;
		}

		state = await applyPlanEdit(state, choice, world);
	}
}

/**
 * Settle the R2 credential pair: taken from the environment when both parts
 * are set, otherwise prompted for (the cache cannot serve without them).
 * Returns undefined when the prompts are cancelled.
 */
export async function collectR2Credentials(
	ui: DeployUi,
	env: Readonly<Record<string, string | undefined>>,
	interactive: boolean
): Promise<R2Credentials | undefined> {
	const fromEnv = (name: string): string | undefined => {
		const value = env[name];

		return value === undefined || value === '' ? undefined : value;
	};

	const envAccessKeyId = fromEnv('R2_ACCESS_KEY_ID');
	const envSecret = fromEnv('R2_SECRET_ACCESS_KEY');

	if (envAccessKeyId !== undefined && envSecret !== undefined) {
		return { accessKeyId: envAccessKeyId, secretAccessKey: envSecret };
	}

	if (!interactive) {
		throw new R2CredentialsRequiredError();
	}

	ui.info(
		'The tenant Worker presigns R2 uploads with an R2 API token ' +
			'(Cloudflare dashboard: R2 → Manage API tokens → Object Read & Write).'
	);

	const accessKeyId =
		envAccessKeyId ??
		(await askText(ui, {
			message: 'R2 access key id',
			problem: accessKeyIdProblem
		}));

	if (accessKeyId === undefined) {
		return undefined;
	}

	const secretAccessKey = await ui.secret(
		'R2 secret access key',
		secretAccessKeyProblem
	);

	if (secretAccessKey === undefined) {
		return undefined;
	}

	return { accessKeyId, secretAccessKey };
}

async function askText(
	ui: DeployUi,
	options: {
		readonly message: string;
		readonly problem: (value: string) => string | undefined;
	}
): Promise<string | undefined> {
	const edit = await ui.editText(options);

	return edit.kind === 'set' ? edit.value : undefined;
}

/**
 * Probe R2 with the pair before deploying anything. Interactively, a rejection
 * offers to re-enter the pair, deploy anyway (a write-only token reads as
 * rejected), or cancel; without a terminal it is fatal.
 */
async function verifyR2Credentials(options: {
	readonly ui: DeployUi;
	readonly interactive: boolean;
	readonly accountId: string;
	readonly bucketName: string;
	readonly initial: R2Credentials;
}): Promise<R2Credentials | undefined> {
	const { ui } = options;
	let credentials = options.initial;

	for (;;) {
		try {
			await ui.reporter().phase('Checking R2 credentials', async () => {
				const check = await checkR2Credentials({
					accountId: options.accountId,
					bucketName: options.bucketName,
					credentials
				});

				if (check.kind === 'rejected') {
					throw new R2CredentialsRejectedError(check.status);
				}

				if (check.kind === 'unreachable') {
					throw new R2UnreachableError({ cause: check.cause });
				}
			});

			return credentials;
		} catch (error) {
			if (!options.interactive || !(error instanceof CliError)) {
				throw error;
			}

			ui.warn(error.message);

			const next = await ui.menu('How would you like to proceed?', [
				{ value: 'reenter', label: 'Re-enter the R2 credentials' },
				{
					value: 'continue',
					label: 'Deploy anyway',
					hint: 'a write-only token fails this check but works'
				},
				{ value: 'cancel', label: 'Cancel' }
			]);

			if (next === undefined || next === 'cancel') {
				return undefined;
			}

			if (next === 'continue') {
				return credentials;
			}

			const reentered = await collectR2Credentials(ui, {}, true);

			if (reentered === undefined) {
				return undefined;
			}

			credentials = reentered;
		}
	}
}

/**
 * Run `cupboard deploy`. Imported lazily by the command shell so its heavy
 * dependencies stay out of the released single-executable's startup path.
 *
 * The order is deliberate: build, authenticate, collect what is missing, then
 * show a complete plan and let the user adjust it before agreeing. After the
 * agreement the only interaction left is a failed credential probe.
 */
export async function executeDeploy(
	cliOptions: DeployCliOptions
): Promise<void> {
	const ui = createDeployUi();
	const interactive = process.stdin.isTTY && process.stdout.isTTY;
	const initialDomain =
		cliOptions.domain === undefined
			? undefined
			: checkDomainOption(cliOptions.domain);

	ui.intro();

	const { artifact, notice } = await ui
		.reporter()
		.phase('Building Workers', () =>
			resolveArtifact(cliOptions.fromTree ?? false)
		);

	if (notice !== undefined) {
		ui.info(notice);
	}

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
			bucketName: bucketNameOf(artifact.config)
		});

		ui.note('Deployment plan', [
			...derivedPlanRows(artifact, assembled.secrets),
			{ label: '', value: '' },
			...choicePlanRows(artifact.config, initialDomain)
		]);
		warnMissing(assembled.missing);
		ui.outro('Dry run: nothing was changed.');
		return;
	}

	if (!interactive && cliOptions.yes !== true) {
		throw new ConfirmationRequiredError();
	}

	let client: Cloudflare;
	let api: CloudflareApi;
	let accountId: string;
	let credentialSource: CredentialSource;

	try {
		({ client, api, accountId, credentialSource } = await resolveCloudflare(
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

	let r2Credentials = await collectR2Credentials(ui, process.env, interactive);

	if (r2Credentials === undefined) {
		ui.cancelled('Deploy aborted.');
		return;
	}

	const apis = new Map<string, CloudflareApi>([[accountId, api]]);
	const apiFor = (id: string): CloudflareApi => {
		const existing = apis.get(id);

		if (existing !== undefined) {
			return existing;
		}

		const created = createCloudflareApi(client, id);
		apis.set(id, created);

		return created;
	};

	// Whether the control Worker already holds the wrapping secret, asked once
	// per account; a fresh secret is generated at most once and reused across
	// re-renders so the value shown to the user is the value deployed.
	const wrapSecretChecks = new Map<string, Promise<readonly string[]>>();
	let generatedWrapSecret: string | undefined;

	const planFor = async (
		state: PlanState
	): Promise<{ options: DeployOptions; missing: readonly string[] }> => {
		const assembled = assembleSecrets({
			env: {
				...process.env,
				R2_ACCESS_KEY_ID: r2Credentials?.accessKeyId,
				R2_SECRET_ACCESS_KEY: r2Credentials?.secretAccessKey
			},
			accountId: state.accountId,
			bucketName: bucketNameOf(state.config)
		});
		const controlSecrets = [...assembled.secrets.control];
		let missing = assembled.missing;

		// Generate the control key wrapping secret on a first deploy, but never
		// overwrite an existing one: a different value cannot unwrap stored data.
		if (missing.includes('CONTROL_KEY_WRAP_SECRET')) {
			let existing = wrapSecretChecks.get(state.accountId);

			if (existing === undefined) {
				existing = ui
					.reporter()
					.phase('Checking existing secrets', () =>
						apiFor(state.accountId).listScriptSecrets(
							artifact.config.control.name
						)
					);
				wrapSecretChecks.set(state.accountId, existing);
			}

			const names = await existing;
			missing = missing.filter((name) => name !== 'CONTROL_KEY_WRAP_SECRET');

			if (!names.includes('CONTROL_KEY_WRAP_SECRET')) {
				const isNewlyGenerated = generatedWrapSecret === undefined;
				generatedWrapSecret ??= generateWrapSecret();
				controlSecrets.push({
					name: 'CONTROL_KEY_WRAP_SECRET',
					text: generatedWrapSecret
				});

				if (isNewlyGenerated) {
					ui.note('Generated CONTROL_KEY_WRAP_SECRET: save this value now', [
						{
							label: 'What',
							value: 'the key that encrypts control-plane signing keys at rest'
						},
						{
							label: 'Why',
							value: 'a different one cannot unwrap existing data'
						},
						{ label: 'Value', value: generatedWrapSecret }
					]);
				}
			}
		}

		return {
			options: {
				domain: state.domain,
				dryRun: false,
				secrets: { control: controlSecrets, tenant: assembled.secrets.tenant }
			},
			missing
		};
	};

	const agreed = await reviewPlan(
		{ accountId, domain: initialDomain, config: artifact.config },
		{
			ui,
			render: async (state) => {
				const { options, missing } = await planFor(state);

				ui.note('Deployment plan', [
					...derivedPlanRows(
						{ ...artifact, config: state.config },
						options.secrets
					),
					{ label: '', value: '' },
					{ label: 'Account', value: state.accountId },
					...choicePlanRows(state.config, state.domain)
				]);
				warnMissing(missing);
			},
			accounts: () => apiFor(accountId).listAccounts(),
			skipReview: cliOptions.yes === true
		}
	);

	if (agreed === undefined) {
		ui.cancelled('Deploy aborted.');
		return;
	}

	const verified = await verifyR2Credentials({
		ui,
		interactive,
		accountId: agreed.accountId,
		bucketName: bucketNameOf(agreed.config),
		initial: r2Credentials
	});

	if (verified === undefined) {
		ui.cancelled('Deploy aborted.');
		return;
	}

	// The probe may have replaced the pair; the deploy must set what passed.
	r2Credentials = verified;

	const { options } = await planFor(agreed);

	await runDeploy({
		artifact: { ...artifact, config: agreed.config },
		api: apiFor(agreed.accountId),
		reporter: ui.reporter(),
		options
	});

	ui.outro(
		agreed.domain === undefined
			? 'Deployed.'
			: `Deployed: https://${agreed.domain}`
	);
}
