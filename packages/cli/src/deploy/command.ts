import { existsSync } from 'node:fs';
import { isSea } from 'node:sea';

import type { CacheAccessMode } from '@cupboard/nix-store/scalars';
import type { InstanceName } from '@cupboard/protocol/instance';
import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import type { ResultRow } from '@cupboard/reporter';
import type Cloudflare from 'cloudflare';
import { APIError } from 'cloudflare';
import { StatusCodes } from 'http-status-codes';

import { delayMs, isAbortError, throwIfAborted } from '../abort.ts';
import type { Audience } from '../audience.ts';
import { BoundSignIn } from '../auth/bound-sign-in.ts';
import { CupboardClient } from '../client/client.ts';
import { controlRpc } from '../client/orpc.ts';
import {
	cacheLoginSession,
	type IdentityLoginOptions,
	identitySignIn,
	isCloudflareSignIn,
	pastedRedirectReader
} from '../commands/login.ts';
import {
	CliError,
	CliUsageError,
	CupboardHttpError,
	UnreachableHostError
} from '../errors.ts';
import { formatHumanError } from '../human-errors.ts';

import { buildArtifactFromTree, type DeploymentArtifact } from './artifact.ts';
import {
	type CredentialSource,
	defaultCredentialChain,
	resolveCloudflare
} from './auth.ts';
import {
	adminAccessFor,
	adminCredentialSources,
	adminLogin,
	type DeployAuthority,
	establishAuthority,
	removeLeftoverClaimSecret,
	tenantMigratorFor,
	withClaimSecret
} from './authority.ts';
import { createEsbuildBundler } from './bundle.ts';
import { fetchClaimFailureLogs } from './claim-logs.ts';
import { claimSecretCleanupApi, removeClaimSecret } from './claim-secret.ts';
import {
	type AccountSummary,
	type CloudflareApi,
	createCloudflareApi
} from './cloudflare-api.ts';
import {
	cronProblem,
	type DeploymentConfig,
	type EditableResourceKind,
	resourceNameProblem
} from './config.ts';
import {
	ControlDatabaseTransferError,
	transferControlDatabase
} from './control-database-transfer.ts';
import { validateTransferredControlDatabase } from './control-database-validation.ts';
import { type D1QueryApi } from './d1-query.ts';
import {
	collectResources,
	deploymentReviewRows,
	type DeployOptions,
	queueRole,
	runDeploy
} from './deploy-run.ts';
import { deploymentUrl, withDeploymentUrl } from './deployment-url.ts';
import { checkDomainOption, domainProblemText } from './domain.ts';
import { EmbeddedArtifactError, loadEmbeddedArtifact } from './embedded.ts';
import {
	type StartingPlan,
	startingPlanLookup
} from './existing-deployment.ts';
import type { CloudflareAccountId } from './identifiers.ts';
import {
	askFirstTenantSlug,
	DeploymentClaimFailedError,
	onboardDeployment,
	type OnboardOutcome
} from './onboard.ts';
import { showReadyCache } from './onboard-ready.ts';
import {
	renameResource,
	withCrons,
	withWorkersInvocationAllowance
} from './overrides.ts';
import { claimantLabel } from './owner.ts';
import {
	checkR2Credentials,
	promptR2CredentialPair,
	r2AccessKeyIdSchema,
	type R2Credentials,
	r2SecretAccessKeySchema
} from './r2-credentials.ts';
import {
	createScopedR2Key,
	TokenManagementNotPermittedError
} from './r2-token.ts';
import {
	assembleSecrets,
	generatePushIdSigningKey,
	generateWrapSecret,
	settlePushIdSigningKey
} from './secrets.ts';
import { settleTenants } from './settlement.ts';
import { planWorkerSource } from './source.ts';
import {
	type DeploymentObservation,
	type DeploymentPlan,
	observeDeployment,
	planBlockedError,
	planDeployment,
	planOfflineDeployment
} from './transition.ts';
import { createDeployUi, type DeployUi, type MenuEntry } from './ui.ts';
import {
	establishWorkersPlan,
	type WorkersAllowance,
	type WorkersPlanOverride
} from './workers-plan.ts';

export class DeploymentSettlementUrlMissingError extends CliError {
	override readonly humanMessage = this.message;
	constructor() {
		super(
			'Tenant work needs a reachable deployment URL. Configure a domain, then resume the deployment.'
		);
		this.name = 'DeploymentSettlementUrlMissingError';
	}
}

export class DeployCancelledError extends CliError {
	override readonly humanMessage = this.message;
	constructor() {
		super('Deploy cancelled');
		this.name = 'DeployCancelledError';
	}
}

export class ConfirmationRequiredError extends CliUsageError {
	constructor() {
		super('Not running in a terminal: pass --yes to deploy without prompts.');
		this.name = 'ConfirmationRequiredError';
	}
}

export class AccountOptionRequiredError extends CliUsageError {
	constructor(public readonly accounts: readonly AccountSummary[]) {
		super(
			'Several Cloudflare accounts are available; pass --account <id>:\n' +
				accounts.map((account) => `  ${account.id}  ${account.name}`).join('\n')
		);
		this.name = 'AccountOptionRequiredError';
	}
}

export class R2CredentialsRequiredError extends CliError {
	override readonly humanMessage = this.message;
	constructor() {
		super(
			'R2 credentials are required: set R2_ACCESS_KEY_ID and ' +
				'R2_SECRET_ACCESS_KEY (an R2 API token scoped to the cache bucket). ' +
				'Create one at https://dash.cloudflare.com/?to=/:account/r2/api-tokens'
		);
		this.name = 'R2CredentialsRequiredError';
	}
}

export class R2UnreachableError extends CliError {
	override readonly humanMessage = this.message;
	constructor(options: { readonly cause: unknown }) {
		super('Could not reach R2 to check the credentials', options);
		this.name = 'R2UnreachableError';
	}
}

export class R2CredentialsRejectedError extends CliError {
	override readonly humanMessage = this.message;
	constructor(public readonly status: number) {
		super(
			`R2 rejected the credentials (HTTP ${String(status)}). ` +
				'Check the access key id and secret, and that the token may write ' +
				'to the cache bucket.'
		);
		this.name = 'R2CredentialsRejectedError';
	}
}

export class FirstCacheAccessRequiredError extends CliUsageError {
	constructor() {
		super(
			"Not running in a terminal: pass --access with --cache to set who may read the first tenant's default cache."
		);
		this.name = 'FirstCacheAccessRequiredError';
	}
}

export class FirstCacheSlugRequiredError extends CliUsageError {
	constructor() {
		super(
			'Not running in a terminal: pass --cache with --access to choose the slug of the first tenant.'
		);
		this.name = 'FirstCacheSlugRequiredError';
	}
}

export interface DeployCliOptions {
	readonly domain?: string;
	readonly instanceName?: InstanceName;
	readonly account?: string;
	/**
	The slug of the first tenant on a new deployment.
	*/
	readonly cache?: string;
	readonly access?: CacheAccessMode;
	/**
	The issuer and client of the admin's login on a first deploy.
	*/
	readonly oidcIssuer: string;
	readonly clientId: string;
	/**
	 * Print the sign-in URL and accept a pasted redirect URL, without opening a
	 * browser, for the admin login on a first deploy or when an update logs in
	 * as the admin.
	 */
	readonly headless?: boolean;
	/**
	 * Authorise an update with the workflow's GitHub Actions OIDC token, through
	 * a control trust rule, instead of a cached `cupboard login` session.
	 */
	readonly githubOidc?: boolean;
	readonly audience?: Audience;
	readonly dryRun?: boolean;
	readonly fromTree?: boolean;
	readonly yes?: boolean;
	readonly wrangler?: boolean;
	readonly workersPlan?: WorkersPlanOverride;
}

export interface DeployRuntimeOptions {
	readonly resultFile?: string;
	readonly signal?: AbortSignal;
	readonly colour?: boolean;
	readonly presentation?: import('@cupboard/reporter').PresentationLevel;
}

function bucketNameOf(config: DeploymentConfig): string {
	return config.tenant.r2Buckets[0]?.bucketName ?? 'cupboard-blobs';
}

// http-status-codes exposes its codes as an enum. `serverError` is widened to
// `number` so the comparison with a response's numeric status is number to
// number.
const serverError: number = StatusCodes.INTERNAL_SERVER_ERROR;
const notFoundStatus: number = StatusCodes.NOT_FOUND;

/**
 * Shows a server-side fault that a deploy probe hit. It reads the exception
 * that the Worker logged for the failing request, found by its cf-ray, and
 * shows it inline. When the log cannot be fetched yet, it shows the command
 * that reads the log.
 */
async function showServerFault(dependencies: {
	readonly ui: DeployUi;
	readonly api: CloudflareApi;
	readonly ray: string | undefined;
	readonly worker: string;
	readonly signal: AbortSignal | undefined;
	readonly lead: string;
}): Promise<void> {
	const { ui, ray, worker, lead } = dependencies;
	if (ui.reporter().presentation !== 'debug') {
		ui.warn(
			`${lead} Fix the reported problem and rerun cupboard deploy with the same release and source. Use --debug to inspect the server diagnostic.`
		);
		return;
	}

	const logged =
		ray === undefined
			? []
			: await fetchClaimFailureLogs({
					api: dependencies.api,
					ray,
					now: Date.now,
					sleep: (ms) => delayMs(ms, { signal: dependencies.signal }),
					signal: dependencies.signal
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
		`${lead} Read the Worker logs${forRay} with \`wrangler tail ${worker} --format json\`, ` +
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
		isFilePresent: existsSync
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
	accounts: readonly AccountSummary[],
	isInteractive: boolean
): Promise<CloudflareAccountId> {
	if (!isInteractive) {
		throw new AccountOptionRequiredError(accounts);
	}

	const chosen = await ui.chooseAccount(accounts);

	if (chosen === undefined) {
		throw new DeployCancelledError();
	}

	return chosen;
}

export interface PlanState {
	readonly accountId: CloudflareAccountId;
	readonly domain: string | undefined;
	readonly config: DeploymentConfig;
	/**
	Replace the R2 credentials the Worker already holds with a new pair.
	*/
	readonly replaceR2Credentials?: boolean;
}

type ResourceChoice = `${EditableResourceKind}:${string}`;
type PlanChoice =
	| 'deploy'
	| 'account'
	| 'domain'
	| 'crons'
	| 'r2-credentials'
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
 * The R2 credentials entry appears only when replacing the pair already on the
 * Worker is a choice worth offering.
 */
export function planMenuEntries(
	state: PlanState,
	canReplaceR2Credentials = false
): MenuEntry<PlanChoice>[] {
	const resources = collectResources(state.config);
	const resourceEntries = (
		kind: EditableResourceKind,
		names: readonly string[]
	): MenuEntry<PlanChoice>[] =>
		names.map((name) => ({
			value: `${kind}:${name}`,
			label:
				kind === 'queue' ? queueRole(state.config, name) : resourceLabels[kind],
			hint: name
		}));

	const r2CredentialEntries: MenuEntry<PlanChoice>[] = canReplaceR2Credentials
		? [
				{
					value: 'r2-credentials',
					label: 'R2 credentials',
					hint:
						state.replaceR2Credentials === true
							? 'replace the current key'
							: 'keep the current key'
				}
			]
		: [];

	return [
		{ value: 'deploy', label: 'Deploy' },
		{ value: 'account', label: 'Account', hint: state.accountId },
		{
			value: 'domain',
			label: 'Custom domain',
			hint: state.domain ?? '(none)'
		},
		...resourceEntries('bucket', resources.r2Buckets),
		...r2CredentialEntries,
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
	if (value.trim() === '') {
		return 'at least one cron trigger is required, because the control Worker runs maintenance only when a cron trigger fires';
	}

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
	/**
	 * Shows the plan for the state and returns the observation of the
	 * deployment that the plan was built from.
	 */
	readonly render: (state: PlanState) => Promise<DeploymentObservation>;
	readonly accounts: () => Promise<readonly AccountSummary[]>;
	readonly skipReview: boolean;
	readonly canReplaceR2Credentials?: (state: PlanState) => Promise<boolean>;
	/**
	 * The configuration that the plan starts from on an account, and the custom
	 * domain routed to that account's control Worker. Switching account
	 * restarts the plan from these values for the chosen account.
	 */
	readonly startingPlanFor: (
		accountId: CloudflareAccountId
	) => Promise<StartingPlan>;
	/**
	 * The domain given with `--domain`. It takes precedence over the routed
	 * custom domain on every account.
	 */
	readonly requestedDomain: string | undefined;
}

async function applyPlanEdit(
	state: PlanState,
	choice: Exclude<PlanChoice, 'deploy' | 'cancel'>,
	world: PlanReviewWorld
): Promise<PlanState> {
	const { ui } = world;

	if (choice === 'account') {
		const chosen = await ui.chooseAccount(await world.accounts());

		if (chosen === undefined || chosen === state.accountId) {
			return state;
		}

		const starting = await world.startingPlanFor(chosen);
		const { replaceR2Credentials: _replaceR2Credentials, ...kept } = state;

		return {
			...kept,
			accountId: chosen,
			config: starting.config,
			domain: world.requestedDomain ?? starting.routedDomain
		};
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

	if (choice === 'r2-credentials') {
		const decision = await ui.menu(
			'The Worker already holds R2 credentials. How should this deploy set them?',
			[
				{ value: 'keep', label: 'Keep the current key' },
				{
					value: 'replace',
					label: 'Replace the current key',
					hint: 'creating a new key invalidates the current one'
				}
			]
		);

		if (decision === undefined) {
			return state;
		}

		return { ...state, replaceR2Credentials: decision === 'replace' };
	}

	if (choice === 'crons') {
		const edit = await ui.editText({
			message: 'Cron triggers, comma separated',
			initial: state.config.control.crons.join(', '),
			placeholder: '0 * * * *',
			problem: cronsListProblem
		});

		if (edit.kind !== 'set') {
			return state;
		}

		const crons = edit.value.split(',').map((cron) => cron.trim());

		return { ...state, config: withCrons(state.config, crons) };
	}

	const separator = choice.indexOf(':');
	const kind = choice.slice(0, separator);

	if (kind !== 'bucket' && kind !== 'database' && kind !== 'queue') {
		return state;
	}

	const name = choice.slice(separator + 1);

	const edit = await ui.editText({
		message: `Rename ${kind === 'queue' ? queueRole(state.config, name) : resourceLabels[kind]} ${name} to`,
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
 * While the plan is blocked, the menu offers only edits and Cancel, and
 * skipping the review or cancelling throws the blocking error.
 */
export async function reviewPlan(
	initial: PlanState,
	world: PlanReviewWorld
): Promise<PlanState | undefined> {
	let state = initial;

	for (;;) {
		const blocked = planBlockedError(await world.render(state));

		if (world.skipReview) {
			if (blocked !== undefined) {
				throw blocked;
			}

			return state;
		}

		const canReplaceR2Credentials =
			world.canReplaceR2Credentials !== undefined &&
			(await world.canReplaceR2Credentials(state));
		const entries = planMenuEntries(state, canReplaceR2Credentials);

		const choice =
			blocked === undefined
				? await world.ui.menu(
						'Deploy to Cloudflare with the plan above?',
						entries
					)
				: await world.ui.menu(
						'The plan above is blocked. Change it or cancel.',
						entries.filter((entry) => entry.value !== 'deploy')
					);

		if (choice === undefined || choice === 'cancel') {
			if (blocked !== undefined) {
				throw blocked;
			}

			return undefined;
		}

		if (choice === 'deploy') {
			return state;
		}

		state = await applyPlanEdit(state, choice, world);
	}
}

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

	return {
		accessKeyId: r2AccessKeyIdSchema.parse(accessKeyId),
		secretAccessKey: r2SecretAccessKeySchema.parse(secretAccessKey)
	};
}

/**
 * What a deploy does about the R2 credentials when the environment does not
 * supply them. It keeps the credentials on the Worker, or it obtains new ones.
 * When the plan changes the bucket that the current credentials were created
 * for, `obtain` includes a `keep` field, and the deploy asks the operator
 * whether to keep those credentials.
 */
export type R2KeyAction =
	| { readonly kind: 'keep' }
	| {
			readonly kind: 'obtain';
			readonly keep?: { readonly previousBucket: string };
	  };

/**
 * Decides what a deploy does about the R2 credentials. `existing` is the
 * existing deployment's configuration. The Worker's current credentials are
 * assumed to be scoped to its bucket, so they are treated as stale only when
 * `agreed` uses another bucket.
 */
export function r2KeyActionFor(options: {
	readonly isAlreadySet: boolean;
	readonly isReplaceRequested: boolean;
	readonly existing: DeploymentConfig;
	readonly agreed: DeploymentConfig;
}): R2KeyAction {
	const previousBucket = bucketNameOf(options.existing);
	const isBucketRenamed = bucketNameOf(options.agreed) !== previousBucket;

	if (!options.isAlreadySet) {
		return { kind: 'obtain' };
	}

	if (isBucketRenamed) {
		return { kind: 'obtain', keep: { previousBucket } };
	}

	return { kind: options.isReplaceRequested ? 'obtain' : 'keep' };
}

export type R2Settlement =
	| {
			readonly kind: 'settled';
			readonly credentials: R2Credentials;
			/**
			True when the key was created just now and may not have propagated.
			*/
			readonly created: boolean;
	  }
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
			readonly isBucketPresent: boolean;
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
	readonly accountId: CloudflareAccountId;
	readonly bucketName: string;
	readonly creation: R2KeyCreation;
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
						hint: creation.isBucketPresent
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
	readonly accountId: CloudflareAccountId;
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
		isBucketPresent: hasBucket,
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
 * Probe R2 with the pair before deploying anything, by beginning and aborting a
 * multipart upload. A freshly created token is retried while it propagates. The
 * probe writes, so a write-only token passes and a rejection means the pair
 * cannot write; interactively a rejection offers to re-enter the pair, deploy
 * anyway, or cancel, and without a terminal it is fatal.
 */
export async function verifyR2Credentials(options: {
	readonly ui: DeployUi;
	readonly interactive: boolean;
	readonly accountId: CloudflareAccountId;
	readonly bucketName: string;
	readonly initial: R2Credentials;
	readonly signal?: AbortSignal;
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
						credentials,
						signal: options.signal
					});

					if (result.kind === 'valid') {
						return;
					}

					if (result.kind === 'unreachable') {
						throw new R2UnreachableError({ cause: result.cause });
					}

					if (result.kind === 'invalid-response') {
						throw result.cause;
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
					hint: 'set this pair without a successful R2 write probe'
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
		colour: runtimeOptions.colour,
		resultFile: runtimeOptions.resultFile,
		presentation: runtimeOptions.presentation
	});
	const isInteractive = ui.interactive;

	try {
		await deployFlow(cliOptions, ui, isInteractive, runtimeOptions);
	} catch (error) {
		if (!(error instanceof APIError)) {
			throw error;
		}

		ui.cancelled(
			formatHumanError(error, {
				debug: runtimeOptions.presentation === 'debug'
			})
		);
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

	requireFirstCacheAccess(cliOptions, isInteractive);
	requireGithubOidcForAudience(cliOptions);

	const { artifact, notice } = await ui
		.reporter()
		.phase(
			'Building Workers',
			() => resolveArtifact(cliOptions.fromTree ?? false),
			{ humanLabel: 'Preparing deployment' }
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
		const offlinePlan = planOfflineDeployment(artifact, cliOptions.workersPlan);
		const assembled = assembleSecrets({
			env: process.env,
			accountId: '',
			bucketName: bucketNameOf(artifact.config)
		});
		const r2Names = new Set(['R2_ACCESS_KEY_ID', 'R2_SECRET_ACCESS_KEY']);

		ui.note('Deployment preview', [
			{
				label: 'Source',
				value:
					cliOptions.fromTree === true || !isSea()
						? 'Working tree'
						: 'Released binary'
			},
			...deploymentReviewRows(
				offlinePlan,
				assembled.secrets,
				initialDomain,
				[],
				runtimeOptions.presentation
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
	let clientWithSignal: (signal: AbortSignal) => Cloudflare;
	let api: CloudflareApi;
	let accountId: CloudflareAccountId;
	let credentialSource: CredentialSource;
	let loginIdToken: string | undefined;

	try {
		({
			client,
			clientWithSignal,
			api,
			accountId,
			credentialSource,
			loginIdToken
		} = await resolveCloudflare(
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

	// From the environment when set; otherwise settled after the plan review,
	// so a created key is scoped to the bucket and account as finally agreed.
	let r2Credentials = envR2Credentials(process.env);

	const apis = new Map<CloudflareAccountId, CloudflareApi>([[accountId, api]]);
	const apiFor = (id: CloudflareAccountId): CloudflareApi => {
		const existing = apis.get(id);

		if (existing !== undefined) {
			return existing;
		}

		const created = createCloudflareApi(client, id);
		apis.set(id, created);

		return created;
	};

	// Cache the secret-name lookup per account. Generate each new secret once so
	// re-rendering the editable plan does not change the value that will deploy.
	const secretChecks = new Map<
		CloudflareAccountId,
		Promise<{ control: readonly string[]; tenant: readonly string[] }>
	>();
	let generatedWrapSecret: string | undefined;
	let generatedPushIdSigningKey: string | undefined;
	// The notes for generated secrets wait until the run is allowed to change
	// the deployment, so a run that stops before any change does not ask the
	// operator to save a value that it never uploads.
	const generatedSecretNotes: {
		readonly title: string;
		readonly rows: readonly ResultRow[];
	}[] = [];

	const existingSecretsFor = (
		accountId: CloudflareAccountId
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

	// Existing R2 secrets survive an upload, but their values cannot be read
	// back. Use their presence to decide whether this deploy must supply a pair.
	const isR2AlreadySetFor = async (state: PlanState): Promise<boolean> => {
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
		const tenantSecrets = [...assembled.secrets.tenant];
		const pendingR2 = assembled.missing.filter((name) =>
			r2SecretNames.has(name)
		);
		const annotated =
			pendingR2.length === 0
				? []
				: (await isR2AlreadySetFor(state))
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
					generatedSecretNotes.push({
						title: 'Generated CONTROL_KEY_WRAP_SECRET: save this value now',
						rows: [
							{
								label: 'What',
								value:
									'Protects the deployment signing keys stored on the server'
							},
							{
								label: 'Why',
								value:
									'Keep this value for recovery. Replacing it prevents the deployment from reading its existing signing keys.'
							},
							{ label: 'Value', value: generatedWrapSecret, raw: true }
						]
					});
				}
			}
		}

		// Both Workers must share the push-ID key. If only one has it, the applied
		// value cannot be read back, so rotate a fresh key onto both.
		if (missing.includes('PUSH_ID_SIGNING_KEY')) {
			const existing = await existingSecretsFor(state.accountId);
			missing = missing.filter((name) => name !== 'PUSH_ID_SIGNING_KEY');
			const settlement = settlePushIdSigningKey(existing);

			if (settlement !== 'keep') {
				const isNewlyGenerated = generatedPushIdSigningKey === undefined;
				generatedPushIdSigningKey ??= generatePushIdSigningKey();
				const secret = {
					name: 'PUSH_ID_SIGNING_KEY',
					text: generatedPushIdSigningKey
				};

				controlSecrets.push(secret);
				tenantSecrets.push(secret);

				if (isNewlyGenerated) {
					generatedSecretNotes.push({
						title:
							settlement === 'rotate'
								? 'Rotated PUSH_ID_SIGNING_KEY: save this value now'
								: 'Generated PUSH_ID_SIGNING_KEY: save this value now',
						rows: [
							{
								label: 'What',
								value: 'Protects upload credentials during publication'
							},
							{
								label: 'Why',
								value:
									settlement === 'rotate'
										? 'The upload key has changed. Publications already in progress need to be retried.'
										: 'Replacing this value invalidates publications already in progress.'
							},
							{ label: 'Value', value: generatedPushIdSigningKey, raw: true }
						]
					});
				}
			}
		}

		return {
			options: {
				domain: state.domain,
				secrets: { control: controlSecrets, tenant: tenantSecrets }
			},
			missing,
			annotated
		};
	};

	const startingPlanFor = startingPlanLookup({
		apiFor,
		defaults: artifact.config,
		phase: (label, read) => ui.reporter().phase(label, read)
	});
	const startingPlan = await startingPlanFor(accountId);

	let reviewedPlan: DeploymentPlan | undefined;
	const accountAllowances = new Map<CloudflareAccountId, WorkersAllowance>();
	const allowanceFor = async (
		account: CloudflareAccountId
	): Promise<WorkersAllowance> => {
		const cached = accountAllowances.get(account);
		if (cached !== undefined) {
			return cached;
		}
		const allowance = await establishWorkersPlan({
			api: apiFor(account),
			ui,
			...(cliOptions.workersPlan !== undefined && {
				override: cliOptions.workersPlan
			}),
			...(runtimeOptions.signal !== undefined && {
				signal: runtimeOptions.signal
			})
		});
		accountAllowances.set(account, allowance);
		return allowance;
	};

	const agreed = await reviewPlan(
		{
			accountId,
			config: startingPlan.config,
			domain: initialDomain ?? startingPlan.routedDomain
		},
		{
			ui,
			render: async (state) => {
				const { options, missing, annotated } = await planFor(state);
				const allowance = await allowanceFor(state.accountId);
				const plannedArtifact = {
					...artifact,
					config: withDeploymentUrl(
						withWorkersInvocationAllowance(state.config, allowance),
						await deploymentUrl(
							apiFor(state.accountId),
							state.config.control.name,
							state.domain
						)
					)
				};
				reviewedPlan = planDeployment(
					plannedArtifact,
					await observeDeployment(apiFor(state.accountId), plannedArtifact),
					allowance.source
				);

				ui.note('Deployment plan', [
					{ label: 'Account', value: state.accountId },
					{
						label: 'Source',
						value:
							cliOptions.fromTree === true || !isSea()
								? 'Working tree'
								: 'Released binary'
					},
					...deploymentReviewRows(
						reviewedPlan,
						options.secrets,
						state.domain,
						annotated,
						runtimeOptions.presentation
					)
				]);
				warnMissing(missing);

				return reviewedPlan.observation;
			},
			accounts: () => apiFor(accountId).listAccounts(),
			skipReview: cliOptions.yes === true,
			canReplaceR2Credentials: async (state) =>
				r2Credentials === undefined && (await isR2AlreadySetFor(state)),
			startingPlanFor,
			requestedDomain: initialDomain
		}
	);

	if (agreed === undefined || reviewedPlan === undefined) {
		ui.cancelled('Deploy aborted.');
		return;
	}

	const agreedStartingPlan = await startingPlanFor(agreed.accountId);
	const agreedApi = apiFor(agreed.accountId);
	const controlName = agreed.config.control.name;
	const loginDependencies = {
		openBrowser: (url: string) => {
			ui.openBrowser(url);
		},
		info: (message: string) => {
			ui.info(message);
		},
		readPastedRedirect: pastedRedirectReader(ui),
		signal: runtimeOptions.signal
	};
	// Without a terminal, the sign-in throws `OwnerLoginRequiredError`, so the
	// run never opens a browser.
	const boundSignIn = (options: IdentityLoginOptions): BoundSignIn =>
		new BoundSignIn(
			isInteractive ? identitySignIn(options, loginDependencies) : undefined
		);
	const claimIdentity: IdentityLoginOptions = {
		oidcIssuer: cliOptions.oidcIssuer,
		clientId: cliOptions.clientId,
		headless: cliOptions.headless
	};

	const authority = await establishAuthority(
		{ agreed },
		{
			ui,
			api: agreedApi,
			adminAccess: adminAccessFor(
				cliOptions,
				adminCredentialSources(runtimeOptions.signal)
			),
			checkAdmin: async (url, credential) => {
				await controlRpc(url, {
					credential,
					signal: runtimeOptions.signal
				}).instance.get();
			},
			signIn: boundSignIn(claimIdentity),
			...(loginIdToken !== undefined &&
				isCloudflareSignIn(claimIdentity) && {
					cloudflareLoginIdToken: loginIdToken
				}),
			...(cliOptions.cache !== undefined && {
				firstTenantSlug: cliOptions.cache
			}),
			chooseFirstTenantSlug: (url) => askFirstTenantSlug(ui, url.origin),
			servesCupboard: (url) =>
				isVersionServed(() =>
					CupboardClient.fromUrl(url, {
						cache: { kind: 'default' },
						signal: runtimeOptions.signal
					}).version()
				),
			...(cliOptions.githubOidc !== true && {
				logInAsAdmin: adminLogin({
					info: (message) => {
						ui.info(message);
					},
					signInFor: (issuer, clientId) =>
						boundSignIn({
							oidcIssuer: issuer,
							clientId,
							headless: cliOptions.headless
						}),
					exchange: (url, token) =>
						CupboardClient.fromUrl(url, {
							cache: { kind: 'default' },
							signal: runtimeOptions.signal
						}).tokenExchange(
							token.idToken,
							subjectTokenTypeIdToken,
							undefined,
							token.binding
						),
					cacheSession: (response, url) =>
						cacheLoginSession(response, url, runtimeOptions.signal),
					defaultClientId: cliOptions.clientId
				})
			}),
			confirmClaim: async (claimant) =>
				cliOptions.yes === true ||
				(await ui.confirm({
					message: `Claim this deployment as ${claimantLabel(claimant)}?`
				})) === 'yes',
			interactive: isInteractive,
			signal: runtimeOptions.signal
		}
	);

	if (authority.kind === 'declined') {
		ui.cancelled('Deploy aborted.');
		return;
	}

	for (const note of generatedSecretNotes) {
		ui.note(note.title, note.rows);
	}

	const firstCacheNote = unclaimedFirstCacheNote(authority, cliOptions);

	if (firstCacheNote !== undefined) {
		ui.warn(firstCacheNote);
	}

	const agreedBucket = bucketNameOf(agreed.config);
	let wasCreatedNow = false;

	if (r2Credentials === undefined) {
		const isAlreadySet = await isR2AlreadySetFor(agreed);
		const r2Key = r2KeyActionFor({
			isAlreadySet,
			isReplaceRequested: agreed.replaceR2Credentials === true,
			existing: agreedStartingPlan.config,
			agreed: agreed.config
		});

		if (r2Key.kind === 'keep') {
			// The values cannot be read back. Once a cache exists, onboarding has
			// the Worker test its stored pair.
			ui.info('Keeping the existing storage credentials.');
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
				...(r2Key.keep !== undefined && { keep: r2Key.keep })
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
			// A run without a terminal needs `--yes`, which skips the review. The
			// plan then has the existing bucket and no request to replace the
			// credentials, so `obtain` means that the Worker has no R2 credentials.
			throw new R2CredentialsRequiredError();
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

		// The interactive probe can replace the pair. Deploy the pair that passed.
		r2Credentials = verified;
	}

	const planned = await planFor(agreed);
	const options = withClaimSecret(planned.options, authority);

	const deployedConfig = reviewedPlan.artifact.config;

	// The settlement waits for the server's required local step, which is the
	// step that the walk asks for while its transition is incomplete. The walk
	// checks the tenants against its own step afterwards.
	const migrateTenants = tenantMigratorFor(authority, async (access) => {
		const url = await deploymentUrl(
			agreedApi,
			deployedConfig.control.name,
			agreed.domain
		);
		if (url === undefined) {
			throw new DeploymentSettlementUrlMissingError();
		}
		const parsed = new URL(url);
		await settleTenants(
			controlRpc(parsed, {
				credential: access.credentialFor(parsed),
				signal: runtimeOptions.signal
			}).localStep,
			ui.reporter(),
			{
				url: parsed,
				...(runtimeOptions.signal !== undefined && {
					signal: runtimeOptions.signal
				})
			}
		);
	});

	const migrateControlDatabase = async (transition: string): Promise<void> => {
		if (transition !== 'control-database-split') {
			return;
		}
		const sourceName = deployedConfig.control.d1Databases.find(
			(binding) => binding.binding === 'CUPBOARD_DB'
		)?.databaseName;
		const targetName = deployedConfig.control.d1Databases.find(
			(binding) => binding.binding === 'CONTROL_DB'
		)?.databaseName;
		const source =
			sourceName === undefined
				? undefined
				: await agreedApi.findD1Database(sourceName);
		const target =
			targetName === undefined
				? undefined
				: await agreedApi.findD1Database(targetName);
		if (source === undefined || target === undefined) {
			throw new ControlDatabaseTransferError(
				'both control database bindings must exist'
			);
		}
		const queryApi: D1QueryApi = {
			queryRows: (id, sql) => agreedApi.d1QueryRows(id, sql),
			queryBatch: (id, statements) => agreedApi.d1QueryBatch(id, statements)
		};
		await transferControlDatabase({
			api: queryApi,
			source,
			target,
			now: new Date(),
			validateKeys: async () => {
				const url = await deploymentUrl(
					agreedApi,
					deployedConfig.control.name,
					agreed.domain
				);
				if (url === undefined) {
					throw new DeploymentSettlementUrlMissingError();
				}
				await validateTransferredControlDatabase({
					api: agreedApi,
					cleanupApi: claimSecretCleanupApi(clientWithSignal, agreed.accountId),
					scriptName: deployedConfig.control.name,
					signal: runtimeOptions.signal,
					validate: (secret, signal) =>
						controlRpc(new URL(url), {
							signal
						}).database.validate({ secret })
				});
			}
		});
	};

	const agreedPlan = reviewedPlan;
	let outcome: OnboardOutcome;

	try {
		outcome = await deployAndOnboard(authority, {
			removeLeftoverClaimSecret: () =>
				removeLeftoverClaimSecret(authority, {
					ui,
					api: agreedApi,
					controlScriptName: controlName,
					controlSecrets: async () => {
						const secrets = await existingSecretsFor(agreed.accountId);

						return secrets.control;
					}
				}),
			deploy: async () => {
				await runDeploy({
					plan: agreedPlan,
					beforeContract: migrateControlDatabase,
					...(migrateTenants !== undefined && {
						settleTenants: migrateTenants
					}),
					api: agreedApi,
					reporter: ui.reporter(),
					options,
					signal: runtimeOptions.signal
				});
			},
			removeClaimSecret: () =>
				removeClaimSecret(
					ui,
					claimSecretCleanupApi(clientWithSignal, agreed.accountId),
					controlName
				),
			onboard: (removeClaimSecretOnce) =>
				onboardDeployment({
					api: agreedApi,
					ui,
					controlScriptName: controlName,
					tenantScriptName: agreed.config.tenant.name,
					domain: agreed.domain,
					instanceName: cliOptions.instanceName,
					authority,
					...(cliOptions.cache !== undefined && {
						cacheSlug: cliOptions.cache
					}),
					cacheAccess: cliOptions.access,
					buildVersion: artifact.buildVersion,
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
					removeClaimSecret: removeClaimSecretOnce
				})
		});
	} catch (error) {
		const fault = claimServerFault(error);

		if (fault === undefined) {
			throw error;
		}

		await showServerFault({
			ui,
			api: agreedApi,
			ray: fault.ray,
			worker: controlName,
			signal: runtimeOptions.signal,
			lead: fault.message
		});

		throw new DeploymentUnclaimedError(fault.url, 'claim-server-error', {
			cause: error
		});
	}

	switch (outcome.kind) {
		case 'no-subdomain': {
			ui.warn(
				'The account has no workers.dev subdomain, so the deployment has ' +
					'no URL yet. Register one in the Cloudflare dashboard ' +
					'(Workers & Pages), then re-run `cupboard init`.'
			);
			endBeforeReady(ui, authority, undefined);
			return;
		}

		case 'unreachable': {
			if (
				outcome.lastStatus !== undefined &&
				outcome.lastStatus >= serverError
			) {
				await showServerFault({
					ui,
					api: agreedApi,
					ray: outcome.lastRay,
					worker: outcome.worker,
					signal: runtimeOptions.signal,
					lead: `Uploaded, but ${outcome.url} is returning a server error (HTTP ${String(outcome.lastStatus)}).`
				});
				endBeforeReady(ui, authority, outcome.url);
				return;
			}

			// Only a genuinely new custom domain warrants the DNS caveat.
			const dnsNote =
				agreed.domain !== undefined &&
				agreedStartingPlan.routedDomain !== agreed.domain
					? ' A freshly added custom domain can take a while to resolve in DNS.'
					: '';

			ui.warn(
				`Uploaded, but ${outcome.url} did not come online in time ` +
					`${runtimeOptions.presentation === 'debug' ? `(last probe: ${outcome.lastProbe}).` : 'Availability has not been confirmed.'}${dnsNote} Once it responds, ` +
					're-run `cupboard init` to finish setting up.'
			);
			endBeforeReady(ui, authority, outcome.url);
			return;
		}

		case 'cancelled': {
			ui.info(
				isInteractive
					? 'No tenant was created yet. Re-run `cupboard init` to choose a ' +
							'slug when you are ready.'
					: 'No first tenant was requested. Re-run `cupboard init` with ' +
							'--cache and --access to create one.'
			);
			ui.outro('Deployment verified; first-tenant setup remains.');
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
			ui.outro('Deployment verified. Manage tenants with `cupboard tenant`.');
			return;
		}

		case 'ready': {
			showReadyCache(ui, outcome);
			return;
		}
	}
}

/**
 * Refuses `--cache` or `--access` without the other on a run without a
 * terminal, because nobody can answer the prompt for the missing value.
 */
export function requireFirstCacheAccess(
	cliOptions: Pick<DeployCliOptions, 'cache' | 'access'>,
	isInteractive: boolean
): void {
	if (isInteractive) {
		return;
	}

	if (cliOptions.cache !== undefined && cliOptions.access === undefined) {
		throw new FirstCacheAccessRequiredError();
	}

	if (cliOptions.access !== undefined && cliOptions.cache === undefined) {
		throw new FirstCacheSlugRequiredError();
	}
}

/**
 * True when `version` returns a build, and false when the host cannot be
 * reached or has no `/_version` route. Any other failure, such as a server
 * error, throws, so a deployment that fails for another reason is not treated
 * as a URL that does not serve Cupboard.
 */
export async function isVersionServed(
	version: () => Promise<unknown>
): Promise<boolean> {
	try {
		await version();

		return true;
	} catch (error) {
		if (
			error instanceof UnreachableHostError ||
			(error instanceof CupboardHttpError && error.status === notFoundStatus)
		) {
			return false;
		}

		throw error;
	}
}

/**
 * Ends a run whose deployment did not become ready for onboarding. A first
 * deploy that stops before the claim leaves the deployment without an admin,
 * and nobody can use it until someone claims it, so the run fails with
 * `DeploymentUnclaimedError`, as a run without a terminal does. The error
 * reaches the CLI's exit code, which the released binary takes from `runCli`.
 */
export function endBeforeReady(
	ui: Pick<DeployUi, 'outro'>,
	authority: Pick<DeployAuthority, 'kind'>,
	url: string | undefined
): void {
	if (authority.kind === 'bootstrap') {
		throw new DeploymentUnclaimedError(url, 'stopped-before-claim');
	}

	ui.outro('Uploaded; deployment availability has not been confirmed.');
}

type ClaimedOnboardOutcome = Exclude<
	OnboardOutcome,
	{ readonly kind: 'unclaimed' }
>;

/**
 * Deploys and onboards in the order that keeps the claim secret short-lived.
 * A leftover claim secret is removed before the upload. For a first deploy,
 * `onboard` receives a removal that deletes the claim secret at most once, and
 * the `finally` calls it too, so the secret is removed on every exit once the
 * deploy starts, including a failed upload or a run that stops before the
 * claim. A run that leaves the deployment without an admin throws
 * `DeploymentUnclaimedError` after the upload.
 */
export async function deployAndOnboard(
	authority: DeployAuthority,
	steps: {
		readonly removeLeftoverClaimSecret: () => Promise<void>;
		readonly deploy: () => Promise<void>;
		readonly removeClaimSecret: () => Promise<void>;
		readonly onboard: (
			removeClaimSecretOnce: () => Promise<void>
		) => Promise<OnboardOutcome>;
	}
): Promise<ClaimedOnboardOutcome> {
	let removal: Promise<void> | undefined;
	const removeClaimSecretOnce = (): Promise<void> => {
		removal ??= steps.removeClaimSecret();

		return removal;
	};

	try {
		await steps.removeLeftoverClaimSecret();
		await steps.deploy();

		const outcome = await steps.onboard(removeClaimSecretOnce);

		if (outcome.kind === 'unclaimed') {
			throw new DeploymentUnclaimedError(outcome.url, 'no-terminal');
		}

		return outcome;
	} finally {
		if (authority.kind === 'bootstrap') {
			await removeClaimSecretOnce();
		}
	}
}

/**
 * Why a first deploy left the deployment without an admin: the run had no
 * terminal to log in from, it stopped before the claim because the deployment
 * did not serve the new build, or `/signup` failed with a server error.
 */
export type UnclaimedReason =
	'no-terminal' | 'stopped-before-claim' | 'claim-server-error';

/**
 * A first deploy left the deployment without an admin. Nobody can create a
 * cache until a run from a terminal claims the deployment, so the run fails
 * although the Workers were deployed.
 */
export class DeploymentUnclaimedError extends CliError {
	override readonly humanMessage: string;
	constructor(
		public readonly url: string | undefined,
		public readonly reason: UnclaimedReason,
		options?: { readonly cause?: unknown }
	) {
		const deployment =
			url === undefined ? 'the deployment' : `the deployment at ${url}`;
		const explanation = {
			'no-terminal':
				'this run had no terminal to log in from, and only an admin can ' +
				'create a cache. Run `cupboard init` from a terminal to claim the ' +
				'deployment.',
			'stopped-before-claim':
				'the deploy stopped before the claim, for the reason shown above. ' +
				'Fix that, then run `cupboard init` from a terminal to claim the ' +
				'deployment.',
			'claim-server-error':
				'the claim failed with a server error. Fix the cause shown above, ' +
				'then run `cupboard init` from a terminal to claim the deployment.'
		}[reason];

		super(`Deployed, but ${deployment} has no admin: ${explanation}`, options);
		this.name = 'DeploymentUnclaimedError';
		this.humanMessage =
			'Uploaded; setup is incomplete because the deployment has no administrator. Fix the reported problem, then run cupboard deploy from a terminal with the same release and source to finish setup.';
	}
}

export class AudienceWithoutGithubOidcError extends CliUsageError {
	constructor() {
		super(
			'--audience applies only to the token that --github-oidc requests; pass --github-oidc with it.'
		);
		this.name = 'AudienceWithoutGithubOidcError';
	}
}

/**
 * Refuses `--audience` without `--github-oidc`, because only the GitHub
 * Actions token request uses the audience.
 */
export function requireGithubOidcForAudience(
	cliOptions: Pick<DeployCliOptions, 'audience' | 'githubOidc'>
): void {
	if (cliOptions.audience !== undefined && cliOptions.githubOidc !== true) {
		throw new AudienceWithoutGithubOidcError();
	}
}

/**
 * The 5xx response from a failed claim, used to look up the Worker's log.
 * Undefined unless `/signup` returned a 5xx status.
 */
export function claimServerFault(error: unknown):
	| {
			readonly message: string;
			readonly ray: string | undefined;
			readonly url: string;
	  }
	| undefined {
	if (
		!(error instanceof DeploymentClaimFailedError) ||
		error.status === undefined ||
		error.status < serverError
	) {
		return undefined;
	}

	return { message: error.message, ray: error.ray, url: error.url.origin };
}

/**
 * The note for `--cache` and `--access` on a run that leaves the deployment
 * without an admin. Undefined when the run has an admin or neither option is
 * passed.
 */
export function unclaimedFirstCacheNote(
	authority: DeployAuthority,
	cliOptions: Pick<DeployCliOptions, 'cache' | 'access'>
): string | undefined {
	if (
		authority.kind !== 'unclaimed' ||
		(cliOptions.cache === undefined && cliOptions.access === undefined)
	) {
		return undefined;
	}

	return (
		'`--cache` and `--access` are not applied, because only an admin can ' +
		'create a tenant. On the run that claims the deployment from a terminal, ' +
		'they replace the prompts. After the claim, a run without a terminal ' +
		'uses them to create the first tenant if the deployment has none.'
	);
}
