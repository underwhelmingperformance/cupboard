import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';

import { NixConfig } from '@cupboard/nix/nix-config';
import type Cloudflare from 'cloudflare';
import { APIError } from 'cloudflare';
import { StatusCodes } from 'http-status-codes';

import { delayMs, isAbortError, throwIfAborted } from '../abort.ts';
import { CupboardClient } from '../client/client.ts';
import { CliError } from '../errors.ts';

import { buildArtifactFromTree, type DeploymentArtifact } from './artifact.ts';
import {
	type CredentialSource,
	defaultCredentialChain,
	freshIdToken,
	resolveCloudflare
} from './auth.ts';
import { createEsbuildBundler } from './bundle.ts';
import { fetchClaimFailureLogs } from './claim-logs.ts';
import { type CloudflareApi, createCloudflareApi } from './cloudflare-api.ts';
import {
	cloudflareOauthClientId,
	refreshCloudflareGrant
} from './cloudflare-oauth.ts';
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
import { checkDomainOption, domainProblemText } from './domain.ts';
import { EmbeddedArtifactError, loadEmbeddedArtifact } from './embedded.ts';
import { readCachedGrant, writeCachedGrant } from './grant-store.ts';
import {
	type ClaimSecret,
	deploymentUrl,
	onboardAdminFor,
	onboardDeployment
} from './onboard.ts';
import { renameResource, withCrons, withSignupGate } from './overrides.ts';
import {
	cloudflareDashIssuer,
	defaultOwnerChoice,
	deployerOwner,
	type OwnerBinding,
	type OwnerChoice,
	ownerFieldProblemText,
	ownerHint,
	ownerIssuerProblemText
} from './owner.ts';
import {
	checkR2Credentials,
	promptR2CredentialPair,
	type R2Credentials
} from './r2-credentials.ts';
import {
	createScopedR2Key,
	TokenManagementNotPermittedError
} from './r2-token.ts';
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
	constructor(
		public readonly accounts: readonly { id: string; name: string }[]
	) {
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

export interface DeployRuntimeOptions {
	readonly signal?: AbortSignal;
	/** ANSI colour preference from `--colour`/`--no-colour`. */
	readonly colour?: boolean;
}

function bucketNameOf(config: DeploymentConfig): string {
	return config.tenant.r2Buckets[0]?.bucketName ?? 'cupboard-blobs';
}

/**
 * Why the server refused the admin claim, by status class: an ownership or
 * claim-secret mismatch, a server-side fault to read in the logs, or (the one
 * case re-running signs in again for) a likely-stale login.
 */
export type ClaimRefusalReason =
	| 'ownership-or-secret'
	| 'server-error'
	| 'stale-login';

// http-status-codes exposes its codes as an enum; widen the two compared
// against a response's numeric status so the comparisons stay number to number.
const forbidden: number = StatusCodes.FORBIDDEN;
const serverError: number = StatusCodes.INTERNAL_SERVER_ERROR;

export function claimRefusalReason(status: number): ClaimRefusalReason {
	if (status === forbidden) {
		return 'ownership-or-secret';
	}

	if (status >= serverError) {
		return 'server-error';
	}

	return 'stale-login';
}

// The operator-facing advice for a refusal that is not a server error; a server
// error is surfaced through `showServerFault` instead, which reads the log.
function claimRefusalAdvice(
	reason: Exclude<ClaimRefusalReason, 'server-error'>
): string {
	switch (reason) {
		case 'ownership-or-secret': {
			return (
				'The deployment may already belong to a different identity, or its ' +
				'claim secret did not match.'
			);
		}

		case 'stale-login': {
			return (
				'Your Cloudflare login may have gone stale; re-running ' +
				'`cupboard init` signs in again.'
			);
		}
	}
}

/**
 * Surface a server-side fault a deploy probe hit: read the exception the Worker
 * logged for the failing request (by its cf-ray) and show it inline, falling
 * back to the exact command that reads the log when it cannot be fetched yet.
 */
async function showServerFault(deps: {
	readonly ui: DeployUi;
	readonly api: CloudflareApi;
	readonly ray: string | undefined;
	readonly worker: string;
	readonly signal: AbortSignal | undefined;
	readonly lead: string;
}): Promise<void> {
	const { ui, ray, worker, lead } = deps;

	const logged =
		ray === undefined
			? []
			: await fetchClaimFailureLogs({
					api: deps.api,
					ray,
					now: Date.now,
					sleep: (ms) => delayMs(ms, { signal: deps.signal }),
					signal: deps.signal
				});

	if (logged.length > 0) {
		ui.warn(`${lead} The Worker logged:`);
		ui.note(
			'Logged exception',
			logged.map((line) => ({ label: '', value: line }))
		);
		ui.info('Fix the cause, then re-run `cupboard init`.');

		return;
	}

	const forRay = ray === undefined ? '' : ` (ray ${ray})`;
	ui.warn(
		`${lead} Read it${forRay} with \`wrangler tail ${worker} --format json\`, ` +
			'or the dashboard Logs tab, then re-run `cupboard init`.'
	);
}

async function resolveArtifact(
	isFromTree: boolean
): Promise<{ artifact: DeploymentArtifact; notice: string | undefined }> {
	const plan = planWorkerSource({
		isSea: isSea(),
		cwd: process.cwd(),
		fromTree: isFromTree,
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
	isInteractive: boolean
): Promise<string> {
	if (!isInteractive) {
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
		{ value: 'owner', label: 'Admin', hint: ownerHint(state.owner) },
		{ value: 'cancel', label: 'Cancel' }
	];
}

function cronsListProblem(value: string): string | undefined {
	const parts = value.split(',').map((cron) => cron.trim());

	for (const part of parts) {
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

	const choice = await ui.menu('Who should administer this deployment?', [
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
			hint: 'the signup gate stays closed; no admin, no tenants'
		},
		{ value: 'keep', label: 'Keep the current admin' }
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
		problem: ownerIssuerProblemText
	});

	if (issuer.kind !== 'set') {
		return state;
	}

	const subject = await ui.editText({
		message: 'Subject (the sub claim of your id_token)',
		initial: current?.subject,
		problem: ownerFieldProblemText
	});

	if (subject.kind !== 'set') {
		return state;
	}

	const audience = await ui.editText({
		message: 'Audience (the OAuth client id the id_token is issued for)',
		initial:
			current?.audience ??
			(issuer.value === cloudflareDashIssuer ? cloudflareOauthClientId : ''),
		problem: ownerFieldProblemText
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
			problem: domainProblemText
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

	if (kind !== 'bucket' && kind !== 'database' && kind !== 'queue') {
		return state;
	}

	const name = choice.slice(separator + 1);

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

	const hasBucket = await ui
		.reporter()
		.phase(`Checking R2 bucket ${bucketName}`, () =>
			api.r2BucketExists(bucketName)
		);

	return {
		kind: 'available',
		bucketExists: hasBucket,
		create: async () => {
			if (!hasBucket) {
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
	readonly signal?: AbortSignal;
	/** Probe attempts before giving up; more for a just-created token. */
	readonly attempts?: number;
	readonly check?: typeof checkR2Credentials;
	readonly sleep?: (ms: number) => Promise<void>;
}): Promise<R2Credentials | undefined> {
	const { ui } = options;
	const check = options.check ?? checkR2Credentials;
	let credentials = options.initial;
	let attempts = options.attempts ?? 1;

	for (;;) {
		throwIfAborted(options.signal);

		try {
			await ui.reporter().phase('Checking R2 credentials', async (context) => {
				for (let attempt = 1; ; attempt += 1) {
					throwIfAborted(options.signal);

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
					await delayMs(propagationDelayMs, {
						delay: options.sleep,
						signal: options.signal
					});
				}
			});

			return credentials;
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}

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
	cliOptions: DeployCliOptions,
	runtimeOptions: DeployRuntimeOptions = {}
): Promise<void> {
	throwIfAborted(runtimeOptions.signal);

	const ui = createDeployUi({
		signal: runtimeOptions.signal,
		colour: runtimeOptions.colour
	});
	const isInteractive = ui.interactive;

	try {
		await deployFlow(cliOptions, ui, isInteractive, runtimeOptions);
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
	isInteractive: boolean,
	runtimeOptions: DeployRuntimeOptions
): Promise<void> {
	throwIfAborted(runtimeOptions.signal);

	const initialDomain =
		cliOptions.domain === undefined
			? undefined
			: checkDomainOption(cliOptions.domain);

	ui.intro('cupboard deploy');

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

	if (!isInteractive && cliOptions.yes !== true) {
		throw new ConfirmationRequiredError();
	}

	let client: Cloudflare;
	let api: CloudflareApi;
	let accountId: string;
	let credentialSource: CredentialSource;
	let subject: string | undefined;
	let idToken: string | undefined;

	try {
		({ client, api, accountId, credentialSource, subject, idToken } =
			await resolveCloudflare(
				cliOptions.account,
				(accounts) => chooseDeployAccount(ui, accounts, isInteractive),
				defaultCredentialChain({
					openBrowser: (url) => {
						ui.openBrowser(url);
					},
					wrangler: cliOptions.wrangler ?? true,
					interactive: isInteractive,
					signal: runtimeOptions.signal
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

	// A domain already routed to the control Worker is part of the current
	// deployment, so the plan starts from it; `--domain` overrides it.
	const currentDomain =
		initialDomain ??
		(await ui
			.reporter()
			.phase('Checking the custom domain', () =>
				api.findCustomDomain(artifact.config.control.name)
			));

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

	// What secrets both Workers already hold, fetched once per account in a
	// single visible step; a fresh wrapping secret is generated at most once
	// and reused across re-renders so the value shown is the value deployed.
	const secretChecks = new Map<
		string,
		Promise<{ control: readonly string[]; tenant: readonly string[] }>
	>();
	let generatedWrapSecret: string | undefined;

	const existingSecretsFor = (
		accountId: string
	): Promise<{ control: readonly string[]; tenant: readonly string[] }> => {
		let existing = secretChecks.get(accountId);

		if (existing === undefined) {
			existing = ui.reporter().phase('Checking existing secrets', async () => {
				const accountApi = apiFor(accountId);
				const [control, tenant] = await Promise.all([
					accountApi.listScriptSecrets(artifact.config.control.name),
					accountApi.listScriptSecrets(artifact.config.tenant.name)
				]);

				return { control, tenant };
			});
			secretChecks.set(accountId, existing);
		}

		return existing;
	};

	const r2SecretNames = new Set(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);

	// The pair the tenant Worker already holds survives a re-deploy untouched,
	// so it only needs settling when neither the environment nor the Worker
	// has it. The values cannot be read back, only their presence.
	const r2AlreadySetFor = async (state: PlanState): Promise<boolean> => {
		const { tenant } = await existingSecretsFor(state.accountId);

		return [...r2SecretNames].every((name) => tenant.includes(name));
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
			const { control } = await existingSecretsFor(state.accountId);
			missing = missing.filter((name) => name !== 'CONTROL_KEY_WRAP_SECRET');

			if (!control.includes('CONTROL_KEY_WRAP_SECRET')) {
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
				secrets: { control: controlSecrets, tenant: assembled.secrets.tenant },
				// Settled right before the deploy runs, on the agreed plan.
				liveBuild: undefined
			},
			missing,
			annotated
		};
	};

	const deployer = subject === undefined ? undefined : deployerOwner(subject);
	const initialOwner = defaultOwnerChoice(artifact.config, subject);

	if (cliOptions.yes === true && initialOwner.kind === 'none') {
		ui.warn(
			'No admin is bound: the signup gate stays closed, so nobody can ' +
				'claim this deployment or create tenants until one is configured.'
		);
	}

	const agreed = await reviewPlan(
		{
			accountId,
			domain: currentDomain,
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
	const isBucketRenamed = agreedBucket !== bucketNameOf(artifact.config);
	let wasCreatedNow = false;

	if (r2Credentials === undefined) {
		const isAlreadySet = await r2AlreadySetFor(agreed);

		if (isAlreadySet && !isBucketRenamed) {
			// The Worker keeps the pair it already holds. The values cannot be
			// read back, so the onboarding asks the deployment to prove them
			// once a cache exists to ask through.
			ui.info('Keeping the R2 credentials already set on the Worker.');
		} else if (isInteractive) {
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
				...(isAlreadySet &&
					isBucketRenamed && {
						keep: { previousBucket: bucketNameOf(artifact.config) }
					})
			});

			if (settlement.kind === 'cancelled') {
				ui.cancelled('Deploy aborted.');
				return;
			}

			if (settlement.kind === 'settled') {
				r2Credentials = settlement.credentials;
				wasCreatedNow = settlement.created;
			}
		} else {
			if (!isAlreadySet) {
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
			interactive: isInteractive,
			accountId: agreed.accountId,
			bucketName: agreedBucket,
			initial: r2Credentials,
			attempts: wasCreatedNow ? propagationAttempts : 1,
			signal: runtimeOptions.signal
		});

		if (verified === undefined) {
			ui.cancelled('Deploy aborted.');
			return;
		}

		// The probe may have replaced the pair; the deploy must set what passed.
		r2Credentials = verified;
	}

	const { options } = await planFor(agreed);

	// The admin gate is applied exactly once, on the agreed config: applying it
	// in the render loop would let repeated edits compound state and config.
	const deployedConfig = withSignupGate(
		agreed.config,
		agreed.owner.kind === 'owner' ? agreed.owner.owner : undefined
	);

	// What the deployment serves right now, so the deploy can skip uploading
	// Workers that already run this build with this configuration.
	const liveBuild = await ui
		.reporter()
		.phase('Checking the deployed build', async (context) => {
			const url = await deploymentUrl(
				apiFor(agreed.accountId),
				agreed.config.control.name,
				agreed.domain
			);

			if (url === undefined) {
				return;
			}

			try {
				const live = await CupboardClient.fromUrl(url, {
					signal: runtimeOptions.signal
				}).version();
				context.fact('live', live);

				return live;
			} catch {
				context.fact('live', 'unreachable');

				return;
			}
		});

	await runDeploy({
		artifact: { ...artifact, config: deployedConfig },
		api: apiFor(agreed.accountId),
		reporter: ui.reporter(),
		options: { ...options, liveBuild }
	});

	// What the claim must present beyond the id_token: the signup secret this
	// deploy just set (its value is in hand), or one already on the Worker
	// (only the operator knows it), or none.
	const suppliedSignupSecret = options.secrets.control.find(
		(secret) => secret.name === 'CUPBOARD_SIGNUP_SECRET'
	)?.text;
	const { control: controlSecrets } = await existingSecretsFor(
		agreed.accountId
	);
	const claimSecret: ClaimSecret =
		suppliedSignupSecret === undefined
			? controlSecrets.includes('CUPBOARD_SIGNUP_SECRET')
				? { kind: 'configured' }
				: { kind: 'none' }
			: { kind: 'known', value: suppliedSignupSecret };

	const outcome = await onboardDeployment({
		api: apiFor(agreed.accountId),
		ui,
		controlScriptName: agreed.config.control.name,
		tenantScriptName: agreed.config.tenant.name,
		domain: agreed.domain,
		admin: onboardAdminFor(
			agreed.owner,
			subject !== undefined && idToken !== undefined
				? { subject, idToken }
				: undefined
		),
		buildVersion: artifact.buildVersion,
		claimSecret,
		signal: runtimeOptions.signal,
		// A pair settled this run was probed client-side before it was set; a
		// kept pair is only on the Worker, so the onboarding proves it there.
		r2:
			r2Credentials === undefined
				? {
						kind: 'kept',
						accountId: agreed.accountId,
						bucketName: agreedBucket
					}
				: { kind: 'fresh' },
		// Only a grant-backed credential can reissue an id_token; raw API
		// tokens carry no identity to begin with.
		...((credentialSource === 'cached login' ||
			credentialSource === 'browser login') && {
			freshIdToken: () =>
				freshIdToken({
					readGrant: readCachedGrant,
					writeGrant: writeCachedGrant,
					refreshGrant: (previous) =>
						refreshCloudflareGrant(
							previous,
							fetch,
							Date.now,
							runtimeOptions.signal
						),
					now: Date.now
				})
		})
	});

	switch (outcome.kind) {
		case 'no-subdomain': {
			ui.warn(
				'The account has no workers.dev subdomain, so the deployment has ' +
					'no URL yet. Register one in the Cloudflare dashboard ' +
					'(Workers & Pages), then re-run `cupboard init`.'
			);
			ui.outro('Deployed.');
			return;
		}

		case 'unreachable': {
			// A status means the host answered, so it is reachable and erroring,
			// not absent: surface it as a server fault rather than blaming DNS.
			if (
				outcome.lastStatus !== undefined &&
				outcome.lastStatus >= serverError
			) {
				await showServerFault({
					ui,
					api: apiFor(agreed.accountId),
					ray: outcome.lastRay,
					worker: outcome.worker,
					signal: runtimeOptions.signal,
					lead: `Deployed, but ${outcome.url} is returning a server error (HTTP ${String(outcome.lastStatus)}).`
				});
				ui.outro('Deployed.');
				return;
			}

			// Only a genuinely new custom domain warrants the DNS caveat.
			const dnsNote =
				agreed.domain !== undefined && currentDomain !== agreed.domain
					? ' A freshly added custom domain can take a while to resolve in DNS.'
					: '';

			ui.warn(
				`Deployed, but ${outcome.url} did not come online in time ` +
					`(last answer: ${outcome.lastProbe}).${dnsNote} Once it responds, ` +
					're-run `cupboard init` to finish setting up.'
			);
			ui.outro('Deployed.');
			return;
		}

		case 'no-admin': {
			ui.warn(
				'Nobody was made admin, so this deployment cannot hold any ' +
					'caches yet. Re-run `cupboard init` and pick an admin to ' +
					'finish setting up.'
			);
			ui.outro('Deployed.');
			return;
		}

		case 'admin-elsewhere': {
			ui.info(
				`${outcome.owner.subject} is the admin of this deployment, so ` +
					'creating its first cache is theirs to do.'
			);
			ui.outro('Deployed.');
			return;
		}

		case 'identity-unproven': {
			ui.warn(
				`The plan makes ${outcome.owner.subject} the admin, but this ` +
					'session used a raw API token, which carries no identity to ' +
					'prove that is you. Re-run `cupboard init` and log in through ' +
					'the browser to finish setting up.'
			);
			ui.outro('Deployed.');
			return;
		}

		case 'claim-refused': {
			const base = `The server did not accept you as the admin: ${outcome.detail}.`;
			const reason = claimRefusalReason(outcome.status);

			if (reason === 'server-error') {
				await showServerFault({
					ui,
					api: apiFor(agreed.accountId),
					ray: outcome.ray,
					worker: agreed.config.control.name,
					signal: runtimeOptions.signal,
					lead: `${base} This is a server-side error.`
				});
			} else {
				ui.warn(`${base} ${claimRefusalAdvice(reason)}`);
			}

			ui.outro('Deployed.');
			return;
		}

		case 'claim-cancelled': {
			ui.info(
				'Nothing was claimed without the claim secret. Re-run ' +
					'`cupboard init` to finish setting up when you have it.'
			);
			ui.outro('Deployed.');
			return;
		}

		case 'cancelled': {
			ui.info(
				'No cache was created yet. Re-run `cupboard init` to pick a ' +
					'name when you are ready.'
			);
			ui.outro('Deployed; you are the admin.');
			return;
		}

		case 'already-initialised': {
			ui.note(
				'Existing caches',
				outcome.slugs.map((slug) => ({
					label: slug,
					value: `${outcome.url}/t/${slug}`
				}))
			);
			ui.outro(
				'Deployed; the caches are untouched. Manage them with `cupboard tenant`.'
			);
			return;
		}

		case 'ready': {
			const nixConfig = new NixConfig(outcome.cacheUrl, outcome.publicKey);
			const nixConfigLines = nixConfig
				.render()
				.trimEnd()
				.split('\n')
				.map((line) => ({ label: '', value: line }));

			ui.note('Add to your nix.conf (e.g. /etc/nix/nix.conf)', [
				{ label: 'Cache URL', value: outcome.cacheUrl },
				{ label: '', value: '' },
				...nixConfigLines
			]);

			ui.outro(
				`Deployed and initialised. Next: cupboard push ${outcome.cacheUrl} ./result`
			);
			return;
		}
	}
}
