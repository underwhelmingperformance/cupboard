import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';
import { setTimeout as delay } from 'node:timers/promises';

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
import {
	createScopedR2Key,
	TokenManagementNotPermittedError
} from './r2-token.ts';
import { assembleSecrets, generateWrapSecret } from './secrets.ts';
import { planWorkerSource } from './source.ts';
import {
	createDeployUi,
	type DeployUi,
	type MenuEntry,
	terminalLink
} from './ui.ts';

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
				'R2_SECRET_ACCESS_KEY (an R2 API token scoped to the cache bucket). ' +
				'Create one at https://dash.cloudflare.com/?to=/:account/r2/api-tokens'
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

/** The R2 pair from the environment, when both parts are present. */
export function envR2Credentials(
	env: Readonly<Record<string, string | undefined>>
): R2Credentials | undefined {
	const fromEnv = (name: string): string | undefined => {
		const value = env[name];

		return value === undefined || value === '' ? undefined : value;
	};

	const accessKeyId = fromEnv('R2_ACCESS_KEY_ID');
	const secretAccessKey = fromEnv('R2_SECRET_ACCESS_KEY');

	if (accessKeyId === undefined || secretAccessKey === undefined) {
		return undefined;
	}

	return { accessKeyId, secretAccessKey };
}

/** Prompt for an existing pair; undefined when cancelled. */
async function promptR2CredentialPair(
	ui: DeployUi,
	accountId: string
): Promise<R2Credentials | undefined> {
	const tokensPage = `https://dash.cloudflare.com/${accountId}/r2/api-tokens`;

	ui.info(
		`Create an R2 API token (Object Read & Write on the cache bucket) at\n${terminalLink(tokensPage, tokensPage)}`
	);

	const accessKeyEdit = await ui.editText({
		message: 'R2 access key id',
		problem: accessKeyIdProblem
	});

	if (accessKeyEdit.kind !== 'set') {
		return undefined;
	}

	const secretAccessKey = await ui.secret(
		'R2 secret access key',
		secretAccessKeyProblem
	);

	if (secretAccessKey === undefined) {
		return undefined;
	}

	return { accessKeyId: accessKeyEdit.value, secretAccessKey };
}

export interface ObtainedR2Credentials {
	readonly credentials: R2Credentials;
	/** True when the key was created just now and may not have propagated. */
	readonly created: boolean;
}

/**
 * Settle the R2 credential pair interactively: create a bucket-scoped key
 * through the Cloudflare API (the recommended path), or take an existing pair.
 * A deploy credential without token-management rights falls back to manual
 * entry with an explanation. Returns undefined when cancelled.
 */
export async function obtainR2Credentials(options: {
	readonly ui: DeployUi;
	readonly accountId: string;
	readonly bucketName: string;
	readonly create: () => Promise<R2Credentials>;
}): Promise<ObtainedR2Credentials | undefined> {
	const { ui, bucketName } = options;

	const choice = await ui.menu(
		`The cache needs R2 credentials for ${bucketName}. How would you like to provide them?`,
		[
			{
				value: 'create',
				label: `Create a key scoped to ${bucketName}`,
				hint: 'recommended; rotated on each deploy'
			},
			{ value: 'enter', label: 'Enter an existing key pair' },
			{ value: 'cancel', label: 'Cancel' }
		]
	);

	if (choice === undefined || choice === 'cancel') {
		return undefined;
	}

	if (choice === 'enter') {
		const credentials = await promptR2CredentialPair(ui, options.accountId);

		return credentials === undefined
			? undefined
			: { credentials, created: false };
	}

	try {
		const credentials = await ui
			.reporter()
			.phase(`Creating an R2 API token for ${bucketName}`, options.create);

		return { credentials, created: true };
	} catch (error) {
		if (!(error instanceof TokenManagementNotPermittedError)) {
			throw error;
		}

		ui.warn(error.message);

		const credentials = await promptR2CredentialPair(ui, options.accountId);

		return credentials === undefined
			? undefined
			: { credentials, created: false };
	}
}

const propagationAttempts = 12;
const propagationDelayMs = 5000;

/**
 * Probe R2 with the pair before deploying anything. A freshly created token
 * is retried while it propagates. Interactively, a rejection offers to
 * re-enter the pair, deploy anyway (a write-only token reads as rejected), or
 * cancel; without a terminal it is fatal.
 */
export async function verifyR2Credentials(options: {
	readonly ui: DeployUi;
	readonly interactive: boolean;
	readonly accountId: string;
	readonly bucketName: string;
	readonly initial: R2Credentials;
	/** Probe attempts before giving up; more for a just-created token. */
	readonly attempts?: number;
	readonly check?: typeof checkR2Credentials;
	readonly sleep?: (ms: number) => Promise<void>;
}): Promise<R2Credentials | undefined> {
	const { ui } = options;
	const check = options.check ?? checkR2Credentials;
	const sleep = options.sleep ?? ((ms: number) => delay(ms));
	let credentials = options.initial;
	let attempts = options.attempts ?? 1;

	for (;;) {
		try {
			await ui.reporter().phase('Checking R2 credentials', async (context) => {
				for (let attempt = 1; ; attempt += 1) {
					const result = await check({
						accountId: options.accountId,
						bucketName: options.bucketName,
						credentials
					});

					if (result.kind === 'valid') {
						return;
					}

					if (result.kind === 'unreachable') {
						throw new R2UnreachableError({ cause: result.cause });
					}

					if (attempt >= attempts) {
						throw new R2CredentialsRejectedError(result.status);
					}

					context.fact(
						'waiting for the new key to propagate, attempt',
						attempt
					);
					await sleep(propagationDelayMs);
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

			const reentered = await promptR2CredentialPair(ui, options.accountId);

			if (reentered === undefined) {
				return undefined;
			}

			credentials = reentered;
			attempts = 1;
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
		const r2Names = new Set(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);

		ui.note('Deployment plan', [
			...derivedPlanRows(
				artifact,
				assembled.secrets,
				assembled.missing.filter((name) => r2Names.has(name))
			),
			{ label: '', value: '' },
			...choicePlanRows(artifact.config, initialDomain)
		]);
		warnMissing(assembled.missing.filter((name) => !r2Names.has(name)));
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

	// From the environment when set; otherwise settled after the plan review,
	// so a created key is scoped to the bucket and account as finally agreed.
	let r2Credentials = envR2Credentials(process.env);

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

	const r2SecretNames = new Set(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);

	const planFor = async (
		state: PlanState
	): Promise<{
		options: DeployOptions;
		missing: readonly string[];
		pending: readonly string[];
	}> => {
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
		// The R2 pair is settled after the review (created or entered), so its
		// absence is pending work rather than a problem to warn about.
		const pending = assembled.missing.filter((name) => r2SecretNames.has(name));
		let missing = assembled.missing.filter((name) => !r2SecretNames.has(name));

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
			missing,
			pending
		};
	};

	const agreed = await reviewPlan(
		{ accountId, domain: initialDomain, config: artifact.config },
		{
			ui,
			render: async (state) => {
				const { options, missing, pending } = await planFor(state);

				ui.note('Deployment plan', [
					...derivedPlanRows(
						{ ...artifact, config: state.config },
						options.secrets,
						pending
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

	const agreedBucket = bucketNameOf(agreed.config);
	let createdNow = false;

	if (r2Credentials === undefined) {
		if (!interactive) {
			throw new R2CredentialsRequiredError();
		}

		const obtained = await obtainR2Credentials({
			ui,
			accountId: agreed.accountId,
			bucketName: agreedBucket,
			create: () =>
				createScopedR2Key(apiFor(agreed.accountId), {
					accountId: agreed.accountId,
					bucketName: agreedBucket
				})
		});

		if (obtained === undefined) {
			ui.cancelled('Deploy aborted.');
			return;
		}

		r2Credentials = obtained.credentials;
		createdNow = obtained.created;
	}

	const verified = await verifyR2Credentials({
		ui,
		interactive,
		accountId: agreed.accountId,
		bucketName: agreedBucket,
		initial: r2Credentials,
		attempts: createdNow ? propagationAttempts : 1
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
