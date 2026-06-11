import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';
import { setTimeout as delay } from 'node:timers/promises';

import { NixConfig } from '@cupboard/nix/nix-config';
import type Cloudflare from 'cloudflare';
import { APIError } from 'cloudflare';

import { CliError } from '../errors.ts';

import { buildArtifactFromTree, type DeploymentArtifact } from './artifact.ts';
import {
	type CredentialSource,
	defaultCredentialChain,
	resolveCloudflare
} from './auth.ts';
import { createEsbuildBundler } from './bundle.ts';
import { type CloudflareApi, createCloudflareApi } from './cloudflare-api.ts';
import { cloudflareOauthClientId } from './cloudflare-oauth.ts';
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
import { onboardDeployment } from './onboard.ts';
import { renameResource, withCrons, withOwner } from './overrides.ts';
import {
	cloudflareDashIssuer,
	defaultOwnerChoice,
	deployerOwner,
	type OwnerBinding,
	type OwnerChoice,
	ownerFieldProblem,
	ownerHint,
	ownerIssuerProblem
} from './owner.ts';
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
	readonly owner: OwnerChoice;
}

type ResourceChoice = `${EditableResourceKind}:${string}`;
type PlanChoice =
	| 'deploy'
	| 'account'
	| 'domain'
	| 'crons'
	| 'owner'
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
		{ value: 'owner', label: 'Owner', hint: ownerHint(state.owner) },
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
	/** The deployer's identity, when the credential carries one. */
	readonly deployer: OwnerBinding | undefined;
	/** True when `--yes` accepted the plan up front. */
	readonly skipReview: boolean;
}

async function editOwner(
	state: PlanState,
	world: PlanReviewWorld
): Promise<PlanState> {
	const { ui } = world;

	const choice = await ui.menu('Who should own this deployment?', [
		...(world.deployer === undefined
			? []
			: [
					{
						value: 'deployer',
						label: 'You, the deployer',
						hint: world.deployer.subject
					} as const
				]),
		{
			value: 'manual',
			label: 'Another OIDC identity',
			hint: 'issuer, subject and audience'
		},
		{
			value: 'none',
			label: 'Nobody',
			hint: 'no admin login; pushes only via write rules minted elsewhere'
		},
		{ value: 'keep', label: 'Keep the current owner' }
	]);

	if (choice === undefined || choice === 'keep') {
		return state;
	}

	if (choice === 'deployer' && world.deployer !== undefined) {
		return {
			...state,
			owner: { kind: 'owner', owner: world.deployer, origin: 'deployer' }
		};
	}

	if (choice === 'none') {
		return { ...state, owner: { kind: 'none' } };
	}

	const current = state.owner.kind === 'owner' ? state.owner.owner : undefined;

	const issuer = await ui.editText({
		message: 'OIDC issuer URL',
		initial: current?.issuer ?? cloudflareDashIssuer,
		problem: ownerIssuerProblem
	});

	if (issuer.kind !== 'set') {
		return state;
	}

	const subject = await ui.editText({
		message: 'Subject (the sub claim of your id_token)',
		initial: current?.subject,
		problem: ownerFieldProblem
	});

	if (subject.kind !== 'set') {
		return state;
	}

	const audience = await ui.editText({
		message: 'Audience (the OAuth client id the id_token is minted for)',
		initial:
			current?.audience ??
			(issuer.value === cloudflareDashIssuer ? cloudflareOauthClientId : ''),
		problem: ownerFieldProblem
	});

	if (audience.kind !== 'set') {
		return state;
	}

	return {
		...state,
		owner: {
			kind: 'owner',
			owner: {
				issuer: issuer.value,
				subject: subject.value,
				audience: audience.value
			},
			origin: 'manual'
		}
	};
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

	if (choice === 'owner') {
		return editOwner(state, world);
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

/** How the R2 credential question was resolved. */
export type R2Settlement =
	| {
			readonly kind: 'settled';
			readonly credentials: R2Credentials;
			/** True when the key was created just now and may not have propagated. */
			readonly created: boolean;
	  }
	/** The pair already on the Worker stays as it is. */
	| { readonly kind: 'keep' }
	| { readonly kind: 'cancelled' };

/**
 * Whether the deploy credential is able to create the scoped key. OAuth
 * grants (the browser login, its cache, and wrangler's token) can never
 * manage API tokens, so for them creation is not offered at all.
 */
export type R2KeyCreation =
	| {
			readonly kind: 'available';
			/** Whether the bucket already exists, so the offer tells no lies. */
			readonly bucketExists: boolean;
			readonly create: () => Promise<R2Credentials>;
	  }
	| { readonly kind: 'unavailable' };

/**
 * Settle the R2 credential pair interactively: create a bucket-scoped key
 * through the Cloudflare API when the deploy credential allows it (the
 * recommended path), or take an existing pair. When the Worker already holds
 * a pair that may no longer fit (the bucket was renamed), keeping it is
 * offered as an explicit choice.
 */
export async function obtainR2Credentials(options: {
	readonly ui: DeployUi;
	readonly accountId: string;
	readonly bucketName: string;
	readonly creation: R2KeyCreation;
	/** Set when the Worker holds a pair that was scoped to another bucket. */
	readonly keep?: { readonly previousBucket: string };
}): Promise<R2Settlement> {
	const { ui, bucketName, creation } = options;

	const settled = (credentials: R2Credentials | undefined): R2Settlement =>
		credentials === undefined
			? { kind: 'cancelled' }
			: { kind: 'settled', credentials, created: false };

	if (creation.kind === 'unavailable' && options.keep === undefined) {
		return settled(await promptR2CredentialPair(ui, options.accountId));
	}

	const message =
		options.keep === undefined
			? `The cache needs R2 credentials for ${bucketName}. How would you like to provide them?`
			: `The cache bucket is now ${bucketName}, but the key on the Worker was set up for ${options.keep.previousBucket}. How should the cache authenticate?`;

	const choice = await ui.menu(message, [
		...(creation.kind === 'available'
			? [
					{
						value: 'create',
						label: `Create a key scoped to ${bucketName}`,
						hint: creation.bucketExists
							? 'recommended; rotated on each deploy'
							: 'creates the bucket too; rotated on each deploy'
					} as const
				]
			: []),
		{ value: 'enter', label: 'Enter an existing key pair' },
		...(options.keep === undefined
			? []
			: [
					{
						value: 'keep',
						label: 'Keep the current key',
						hint: `may still be scoped to ${options.keep.previousBucket}`
					} as const
				]),
		{ value: 'cancel', label: 'Cancel' }
	]);

	if (choice === undefined || choice === 'cancel') {
		return { kind: 'cancelled' };
	}

	if (choice === 'keep') {
		return { kind: 'keep' };
	}

	if (choice === 'enter' || creation.kind === 'unavailable') {
		return settled(await promptR2CredentialPair(ui, options.accountId));
	}

	try {
		const credentials = await creation.create();

		return { kind: 'settled', credentials, created: true };
	} catch (error) {
		if (!(error instanceof TokenManagementNotPermittedError)) {
			throw error;
		}

		ui.warn(error.message);

		return settled(await promptR2CredentialPair(ui, options.accountId));
	}
}

/**
 * Whether and how this deploy can create the scoped key. Only an explicit API
 * token can hold token-management rights; OAuth grants (the browser login,
 * its cache, wrangler's token) are never offered creation, since Cloudflare
 * has no token-management scope for them. The bucket existence check runs
 * only when creation is on the table, and the bucket is created first, as its
 * own visible step: a key cannot be scoped to a bucket that does not exist,
 * and the reconcile step later treats an existing bucket as already done.
 */
async function r2KeyCreationFor(options: {
	readonly ui: DeployUi;
	readonly api: CloudflareApi;
	readonly credentialSource: CredentialSource;
	readonly accountId: string;
	readonly bucketName: string;
}): Promise<R2KeyCreation> {
	const { ui, api, accountId, bucketName } = options;

	if (options.credentialSource !== 'environment') {
		return { kind: 'unavailable' };
	}

	const bucketExists = await ui
		.reporter()
		.phase(`Checking R2 bucket ${bucketName}`, () =>
			api.r2BucketExists(bucketName)
		);

	return {
		kind: 'available',
		bucketExists,
		create: async () => {
			if (!bucketExists) {
				await ui
					.reporter()
					.phase(`Creating R2 bucket ${bucketName}`, () =>
						api.ensureR2Bucket(bucketName)
					);
			}

			return ui
				.reporter()
				.phase(`Creating an R2 API token for ${bucketName}`, () =>
					createScopedR2Key(api, { accountId, bucketName })
				);
		}
	};
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
 */
export async function executeDeploy(
	cliOptions: DeployCliOptions
): Promise<void> {
	const ui = createDeployUi();
	const interactive = process.stdin.isTTY && process.stdout.isTTY;

	try {
		await deployFlow(cliOptions, ui, interactive);
	} catch (error) {
		if (!(error instanceof APIError)) {
			throw error;
		}

		// The SDK error's own message is the raw response body; surface just
		// the human-readable details Cloudflare provided.
		const detail =
			error.errors.map((item) => item.message).join('; ') ||
			`HTTP ${String(error.status)}`;
		ui.cancelled(`Cloudflare rejected the deploy: ${detail}`);
		process.exitCode = 1;
	}
}

/**
 * The deploy flow proper. The order is deliberate: build, authenticate, then
 * show a complete plan and let the user adjust it before agreeing. After the
 * agreement the only interaction left is settling the R2 credentials.
 */
async function deployFlow(
	cliOptions: DeployCliOptions,
	ui: DeployUi,
	interactive: boolean
): Promise<void> {
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
				assembled.missing
					.filter((name) => r2Names.has(name))
					.map((name) => `${name} (pending)`)
			),
			{ label: '', value: '' },
			...choicePlanRows(
				artifact.config,
				initialDomain,
				// A dry run never authenticates, so no deployer identity exists.
				defaultOwnerChoice(artifact.config)
			)
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
	let subject: string | undefined;

	try {
		({ client, api, accountId, credentialSource, subject } =
			await resolveCloudflare(
				cliOptions.account,
				(accounts) => chooseDeployAccount(ui, accounts, interactive),
				defaultCredentialChain({
					openBrowser: (url) => {
						ui.openBrowser(url);
					},
					wrangler: cliOptions.wrangler ?? true,
					interactive
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

	// Whether a Worker already holds particular secrets, asked once per
	// account and script; a fresh wrapping secret is generated at most once
	// and reused across re-renders so the value shown is the value deployed.
	const secretChecks = new Map<string, Promise<readonly string[]>>();
	let generatedWrapSecret: string | undefined;

	const existingSecretsFor = (
		accountId: string,
		scriptName: string
	): Promise<readonly string[]> => {
		const key = `${accountId}:${scriptName}`;
		let existing = secretChecks.get(key);

		if (existing === undefined) {
			existing = ui
				.reporter()
				.phase('Checking existing secrets', () =>
					apiFor(accountId).listScriptSecrets(scriptName)
				);
			secretChecks.set(key, existing);
		}

		return existing;
	};

	const r2SecretNames = new Set(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);

	// The pair the tenant Worker already holds survives a re-deploy untouched,
	// so it only needs settling when neither the environment nor the Worker
	// has it. The values cannot be read back, only their presence.
	const r2AlreadySetFor = async (state: PlanState): Promise<boolean> => {
		const existing = await existingSecretsFor(
			state.accountId,
			state.config.tenant.name
		);

		return [...r2SecretNames].every((name) => existing.includes(name));
	};

	const planFor = async (
		state: PlanState
	): Promise<{
		options: DeployOptions;
		missing: readonly string[];
		annotated: readonly string[];
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
		// The R2 pair is settled after the review (kept, created or entered),
		// so its absence is pending work rather than a problem to warn about.
		const pendingR2 = assembled.missing.filter((name) =>
			r2SecretNames.has(name)
		);
		const annotated =
			pendingR2.length === 0
				? []
				: (await r2AlreadySetFor(state))
					? pendingR2.map((name) => `${name} (already set)`)
					: pendingR2.map((name) => `${name} (pending)`);
		let missing = assembled.missing.filter((name) => !r2SecretNames.has(name));

		// Generate the control key wrapping secret on a first deploy, but never
		// overwrite an existing one: a different value cannot unwrap stored data.
		if (missing.includes('CONTROL_KEY_WRAP_SECRET')) {
			const names = await existingSecretsFor(
				state.accountId,
				artifact.config.control.name
			);
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
			annotated
		};
	};

	const deployer = subject === undefined ? undefined : deployerOwner(subject);
	const initialOwner = defaultOwnerChoice(artifact.config, subject);

	if (cliOptions.yes === true && initialOwner.kind === 'none') {
		ui.warn(
			'No owner is bound: `cupboard login` and the admin commands will not ' +
				'work against this deployment until one is configured.'
		);
	}

	const agreed = await reviewPlan(
		{
			accountId,
			domain: initialDomain,
			config: artifact.config,
			owner: initialOwner
		},
		{
			ui,
			render: async (state) => {
				const { options, missing, annotated } = await planFor(state);

				ui.note('Deployment plan', [
					...derivedPlanRows(
						{ ...artifact, config: state.config },
						options.secrets,
						annotated
					),
					{ label: '', value: '' },
					{ label: 'Account', value: state.accountId },
					...choicePlanRows(state.config, state.domain, state.owner)
				]);
				warnMissing(missing);
			},
			accounts: () => apiFor(accountId).listAccounts(),
			deployer,
			skipReview: cliOptions.yes === true
		}
	);

	if (agreed === undefined) {
		ui.cancelled('Deploy aborted.');
		return;
	}

	const agreedBucket = bucketNameOf(agreed.config);
	const bucketRenamed = agreedBucket !== bucketNameOf(artifact.config);
	let createdNow = false;

	if (r2Credentials === undefined) {
		const alreadySet = await r2AlreadySetFor(agreed);

		if (alreadySet && !bucketRenamed) {
			// The Worker keeps the pair it already holds; nothing to settle, and
			// nothing to probe, since the values cannot be read back.
			ui.info('Keeping the R2 credentials already set on the Worker.');
		} else if (interactive) {
			const settlement = await obtainR2Credentials({
				ui,
				accountId: agreed.accountId,
				bucketName: agreedBucket,
				creation: await r2KeyCreationFor({
					ui,
					api: apiFor(agreed.accountId),
					credentialSource,
					accountId: agreed.accountId,
					bucketName: agreedBucket
				}),
				...(alreadySet && bucketRenamed
					? { keep: { previousBucket: bucketNameOf(artifact.config) } }
					: {})
			});

			if (settlement.kind === 'cancelled') {
				ui.cancelled('Deploy aborted.');
				return;
			}

			if (settlement.kind === 'settled') {
				r2Credentials = settlement.credentials;
				createdNow = settlement.created;
			}
		} else {
			if (!alreadySet) {
				throw new R2CredentialsRequiredError();
			}

			ui.warn(
				'The cache bucket was renamed, and the R2 key already on the ' +
					'Worker may be scoped to the old name. Re-run interactively to ' +
					'replace it.'
			);
		}
	}

	if (r2Credentials !== undefined) {
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
	}

	const { options } = await planFor(agreed);

	// The owner is applied exactly once, on the agreed config: applying it in
	// the render loop would let repeated edits compound state and config.
	const deployedConfig = withOwner(
		agreed.config,
		agreed.owner.kind === 'owner' ? agreed.owner.owner : undefined
	);

	await runDeploy({
		artifact: { ...artifact, config: deployedConfig },
		api: apiFor(agreed.accountId),
		reporter: ui.reporter(),
		options
	});

	const outcome = await onboardDeployment({
		api: apiFor(agreed.accountId),
		ui,
		controlScriptName: agreed.config.control.name,
		domain: agreed.domain
	});

	if (outcome.kind === 'no-subdomain') {
		ui.warn(
			'The account has no workers.dev subdomain, so the cache has no URL ' +
				'yet. Register one in the Cloudflare dashboard (Workers & Pages), ' +
				'then run `cupboard config <url> <pubkey>` for the nix.conf lines.'
		);
		ui.outro('Deployed.');
		return;
	}

	if (outcome.kind === 'unreachable') {
		ui.warn(
			`Deployed, but ${outcome.url} did not come online in time. A fresh ` +
				'custom domain can take a while in DNS; once it resolves, run ' +
				`\`cupboard config ${outcome.url} <pubkey>\` for the nix.conf lines.`
		);
		ui.outro('Deployed.');
		return;
	}

	ui.note('Add to your nix.conf (e.g. /etc/nix/nix.conf)', [
		{ label: 'Cache URL', value: outcome.url },
		{ label: '', value: '' },
		...new NixConfig(outcome.url, outcome.publicKey)
			.render()
			.trimEnd()
			.split('\n')
			.map((line) => ({ label: '', value: line }))
	]);

	const nextSteps = [
		...(agreed.owner.kind === 'owner' ? [`cupboard login ${outcome.url}`] : []),
		`cupboard push ${outcome.url} ./result`
	];

	ui.outro(`Deployed and initialised. Next: ${nextSteps.join(' · ')}`);
}
