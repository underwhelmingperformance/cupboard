import { createHash } from 'node:crypto';

import { tenantUrl } from '@cupboard/nix-store/cache-url';
import {
	type CacheAccessMode,
	cacheNamePattern
} from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import type {
	ConfiguredInstanceSummary,
	InstanceName,
	InstanceSummary
} from '@cupboard/protocol/instance';
import { instanceNameSchema } from '@cupboard/protocol/instance';
import {
	subjectTokenProblems,
	subjectTokenTypeIdToken
} from '@cupboard/protocol/oidc';
import type {
	ControlCheckReport,
	R2CredentialCheck
} from '@cupboard/protocol/reports';
import type { SignupResponse } from '@cupboard/protocol/signup';
import {
	defaultReadUser,
	type MembershipRebuildResponse,
	type TenantCreateBodyInput,
	type TenantListResponse,
	type TenantReadCredential,
	type TenantSummary
} from '@cupboard/protocol/tenants';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import { delayMs, isAbortError, throwIfAborted } from '../abort.ts';
import { cachedOwnerProvider } from '../auth/auth.ts';
import {
	type CachedSession,
	sessionFromTokenResponse,
	writeCachedSession
} from '../auth/token-store.ts';
import { type AccessCredential, CupboardClient } from '../client/client.ts';
import { controlRpc, tenantRpc } from '../client/orpc.ts';
import { isRpcNotFoundError } from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import {
	CliError,
	CupboardHttpError,
	UnreachableHostError
} from '../errors.ts';
import { ownDisplayName, principalLabel } from '../principal.ts';
import { generateReadPassword } from '../read-user.ts';

import type { DeployAuthority } from './authority.ts';
import { removeClaimSecret } from './claim-secret.ts';
import type { CloudflareApi } from './cloudflare-api.ts';
import { deploymentUrl } from './deployment-url.ts';
import type { CloudflareAccountId, ScriptName } from './identifiers.ts';
import { showCacheCredential } from './onboard-ready.ts';
import {
	adminLoginCommand,
	type Claimant,
	isSamePrincipal,
	type OwnerBinding,
	type Principal,
	principalOf
} from './owner.ts';
import {
	checkR2Credentials,
	promptR2CredentialPair
} from './r2-credentials.ts';
import type { ClaimSecret } from './secrets.ts';
import type { DeployUi } from './ui.ts';

type Probe<T> =
	| { readonly kind: 'ready'; readonly value: T }
	| {
			readonly kind: 'retry';
			readonly detail: string;
			readonly status?: number;
			readonly ray?: string;
	  }
	/**
	A non-retryable response; polling stops immediately.
	*/
	| {
			readonly kind: 'stop';
			readonly detail: string;
			readonly status: number;
			readonly ray?: string;
	  };

interface CreatedCache {
	readonly access: CacheAccessMode;
	readonly read: TenantReadCredential;
}

export type OnboardOutcome =
	| {
			readonly kind: 'ready';
			readonly url: string;
			readonly slug: string;
			readonly cacheUrl: URL;
			readonly publicKey: string;
			/**
			Access of an existing cache, when the deployer can inspect it.
			*/
			readonly access?: CacheAccessMode;
			readonly created?: CreatedCache;
	  }
	/**
	 * No admin exists, and the run had no terminal to log in from. `url` is
	 * absent when the deployment has no URL yet.
	 */
	| { readonly kind: 'unclaimed'; readonly url: string | undefined }
	| { readonly kind: 'cancelled'; readonly url: string }
	| {
			/**
			Several caches already exist, so there is no "first" to create.
			*/
			readonly kind: 'already-initialised';
			readonly url: string;
			readonly slugs: readonly string[];
	  }
	| {
			readonly kind: 'unreachable';
			readonly url: string;
			readonly lastProbe: string;
			/**
			Present for an HTTP response and absent for a network failure.
			*/
			readonly lastStatus?: number;
			readonly lastRay?: string;
			readonly worker: string;
	  }
	| { readonly kind: 'no-subdomain' };

/**
 * What the onboarding drives: the raw endpoints {@link CupboardClient}
 * serves, plus the control procedures in the contract's shapes. Each control
 * call takes the admin credential as an argument, because a first deploy
 * obtains the credential after it builds the client. The default factory
 * creates a derived client for each control call and binds that call's
 * credential.
 */
export interface OnboardClient extends Pick<
	CupboardClient,
	'version' | 'signup' | 'tokenExchange' | 'publicKey'
> {
	cacheAccess(subjectToken: string): Promise<CacheAccessMode | undefined>;
	getInstance(credential: AccessCredential): Promise<InstanceSummary>;
	initialiseInstance(
		credential: AccessCredential,
		name: InstanceName
	): Promise<ConfiguredInstanceSummary>;
	listTenants(credential: AccessCredential): Promise<TenantListResponse>;
	createTenant(
		credential: AccessCredential,
		body: TenantCreateBodyInput
	): Promise<TenantSummary>;
	rebuildMembership(
		credential: AccessCredential
	): Promise<MembershipRebuildResponse>;
	controlCheck(credential: AccessCredential): Promise<ControlCheckReport>;
}

function defaultInstanceName(publicUrl: string): InstanceName {
	const identity = createHash('sha256')
		.update(new URL(publicUrl).origin)
		.digest('hex')
		.slice(0, 16);

	return instanceNameSchema.parse(`cupboard-${identity}`);
}

/**
 * How this deploy settled the Worker's R2 pair: freshly set after a
 * client-side probe, or kept in place. A kept pair's values cannot be read
 * back, so the Worker proves it after a cache exists.
 */
export type OnboardR2 =
	| {
			readonly kind: 'kept';
			readonly accountId: CloudflareAccountId;
			readonly bucketName: string;
	  }
	| { readonly kind: 'fresh' };

export interface OnboardOptions {
	readonly api: CloudflareApi;
	readonly ui: DeployUi;
	readonly controlScriptName: ScriptName;
	readonly tenantScriptName: ScriptName;
	readonly domain: string | undefined;
	readonly instanceName?: InstanceName;
	/**
	Who may change the deployment, determined before the deploy.
	*/
	readonly authority: DeployAuthority;
	/**
	 * Read access for the first cache. Prompt for access when this is absent.
	 */
	readonly cacheAccess: CacheAccessMode | undefined;
	readonly buildVersion: string;
	readonly r2: OnboardR2;
	readonly signal?: AbortSignal;
	/**
	 * An id_token for the operator, fetched at the moment of use, to read the
	 * access mode of an existing cache. Without one, the outcome does not
	 * report the cache's access.
	 */
	readonly freshIdToken?: () => Promise<string | undefined>;
	readonly clientFactory?: (url: string) => OnboardClient;
	readonly cacheSession?: (
		session: CachedSession,
		target: URL
	) => Promise<void>;
	/**
	 * The admin credential once a first deploy has claimed the deployment and
	 * cached its session; by default the cached session, renewed as it nears
	 * expiry.
	 */
	readonly sessionCredential?: (target: URL) => AccessCredential;
	/**
	 * Removes the claim secret after the claim attempt. By default it deletes
	 * the secret from the control Worker; the deploy passes a function that
	 * deletes it at most once, so that it can also remove the secret when the
	 * run stops before the claim.
	 */
	readonly removeClaimSecret?: () => Promise<void>;
	readonly checkCredentials?: typeof checkR2Credentials;
	readonly readPassword?: () => string;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly attempts?: number;
}

const defaultAttempts = 30;
const attemptDelayMs = 4000;
const conflictStatusCode: number = StatusCodes.CONFLICT;

export type SlugProblem = 'empty' | 'invalid-format';

export function slugProblem(value: string): SlugProblem | undefined {
	if (value === '') {
		return 'empty';
	}

	if (!cacheNamePattern.test(value)) {
		return 'invalid-format';
	}

	return undefined;
}

export function slugProblemMessage(problem: SlugProblem): string {
	switch (problem) {
		case 'empty': {
			return 'a slug is required';
		}
		case 'invalid-format': {
			return (
				'use lowercase letters, digits, ".", "_" or "-", starting with a ' +
				'letter or digit (63 characters at most)'
			);
		}
	}
}

export function slugProblemText(value: string): string | undefined {
	const problem = slugProblem(value);

	return problem === undefined ? undefined : slugProblemMessage(problem);
}

/**
 * Turns a deployed Worker into a usable cache, in two steps.
 *
 * First the deployment must be up: its URL is resolved (the custom domain, or
 * the account's workers.dev subdomain with the script's route enabled) and the
 * unauthenticated `/_version` route is polled until it returns the version
 * just uploaded, since routing, DNS and the new Worker version all take time to
 * settle and an older version may respond in the meantime with the old
 * configuration.
 *
 * Then it is initialised with an admin credential. A first deploy claims the
 * deployment for the operator with the claim secret and their
 * id_token, caches the admin token for the other commands and deletes the
 * secret. An update uses the admin token that the deploy checked before it
 * changed anything. A slug is chosen for the first cache (the create call
 * fails with a conflict when the slug is taken, and the deploy then asks for
 * another slug), and the new cache's `/pubkey` is polled, since the first
 * successful request creates the signing key.
 */
export async function onboardDeployment(
	options: OnboardOptions
): Promise<OnboardOutcome> {
	const { ui, authority } = options;
	const clientFactory =
		options.clientFactory ??
		((url: string) => onboardClientFor(url, options.signal));
	const cacheSession = options.cacheSession ?? writeCachedSession;
	const sessionCredential =
		options.sessionCredential ??
		((target: URL) => cachedOwnerProvider(target, { signal: options.signal }));
	const attempts = options.attempts ?? defaultAttempts;
	const signal = options.signal;

	throwIfAborted(signal);

	const resolved = await resolveDeploymentUrl(options);

	// Nothing after this point applies to a deployment without an admin, so the
	// run does not wait for the new build.
	if (authority.kind === 'unclaimed') {
		return { kind: 'unclaimed', url: resolved };
	}

	if (resolved === undefined) {
		return { kind: 'no-subdomain' };
	}

	const url = resolved;
	const client = clientFactory(url);

	const up = await pollProbe(
		ui,
		`Waiting for build ${options.buildVersion} to be ready`,
		attempts,
		options.sleep,
		signal,
		async () => {
			const live = await client.version();

			return live === options.buildVersion
				? { kind: 'ready', value: undefined }
				: { kind: 'retry', detail: `still serving ${live}` };
		}
	);

	if (up.kind === 'gave-up') {
		return {
			kind: 'unreachable',
			url,
			lastProbe: up.lastProbe,
			worker: options.controlScriptName,
			...(up.lastStatus !== undefined && { lastStatus: up.lastStatus }),
			...(up.lastRay !== undefined && { lastRay: up.lastRay })
		};
	}

	const target = parseWorkerUrl(url);
	let owner: OwnerBinding;
	let credential: AccessCredential;
	let identityToken = options.freshIdToken;

	if (authority.kind === 'bootstrap') {
		owner = await claimDeployment({
			ui,
			client,
			url,
			claimSecret: authority.claimSecret,
			idToken: authority.idToken,
			claimant: authority.claimant,
			removeClaimSecret:
				options.removeClaimSecret ??
				(() => removeClaimSecret(ui, options.api, options.controlScriptName)),
			buildVersion: options.buildVersion,
			cacheSession,
			attempts,
			sleep: options.sleep,
			signal
		});
		credential = sessionCredential(target);
		identityToken = authority.idToken;
	} else {
		owner = authority.admin;
		credential = authority.access.credentialFor(target);
	}

	const currentInstance = await ui
		.reporter()
		.phase('Reading instance identity', () => client.getInstance(credential));
	const instanceName =
		options.instanceName ??
		(currentInstance.state === 'configured'
			? currentInstance.name
			: defaultInstanceName(url));

	await ui
		.reporter()
		.phase('Configuring instance identity', () =>
			client.initialiseInstance(credential, instanceName)
		);

	// Read before creating: a re-run against an initialised deployment must
	// skip the slug prompt, and several caches mean there is no "first".
	const existing = await ui
		.reporter()
		.phase('Checking existing caches', async () => {
			const listed = await client.listTenants(credential);

			return listed.tenants.filter((tenant) => tenant.status !== 'offboarded');
		});

	// Existing tenants were provisioned by an earlier build, and a deploy can
	// change how admission is represented, leaving them inadmissible until the
	// hourly cron reasserts the gate. Reassert it now from the registry so they
	// stay reachable. A fresh deploy has none yet; the create below establishes
	// the first tenant's gate itself.
	if (existing.length > 0) {
		await ui
			.reporter()
			.phase('Refreshing tenant membership', async (context) => {
				const { tenants } = await client.rebuildMembership(credential);
				context.fact('tenants', tenants);
			});
	}

	if (existing.length > 1) {
		return {
			kind: 'already-initialised',
			url,
			slugs: existing.map((tenant) => tenant.id)
		};
	}

	let slug: string;
	let first: FirstTenant | undefined;
	const sole = existing[0];

	if (sole === undefined) {
		const ownerAudience = owner.audience;

		if (ownerAudience === undefined) {
			throw new OwnerAudienceUnknownError(owner);
		}

		first = await createFirstTenant(
			ui,
			client,
			url,
			credential,
			{ ...owner, audience: ownerAudience },
			options.cacheAccess,
			{
				user: defaultReadUser,
				password: (options.readPassword ?? generateReadPassword)()
			}
		);

		if (first === undefined) {
			return { kind: 'cancelled', url };
		}

		slug = first.tenant.id;
		showCacheCredential(
			ui,
			tenantUrl(parseWorkerUrl(url), slug),
			first,
			'confirmed'
		);
	} else {
		ui.info(`The cache "${sole.id}" already exists; nothing to create.`);
		slug = sole.id;
	}

	// The client cannot test a kept pair because it cannot read the stored
	// secrets. Once a cache exists, its Durable Object can test the pair.
	if (options.r2.kind === 'kept') {
		await ensureWorkerR2({
			ui,
			api: options.api,
			client,
			credential,
			r2: options.r2,
			tenantScriptName: options.tenantScriptName,
			check: options.checkCredentials ?? checkR2Credentials,
			attempts,
			sleep: options.sleep,
			signal
		});
	}

	const cacheUrl = tenantUrl(parseWorkerUrl(url), slug);
	const cacheHref = canonicalHref(cacheUrl);
	const cacheClient = clientFactory(cacheHref);

	const key = await pollProbe(
		ui,
		'Initialising the cache',
		attempts,
		options.sleep,
		signal,
		async () => ({ kind: 'ready', value: await cacheClient.publicKey() })
	);

	if (key.kind === 'gave-up') {
		return {
			kind: 'unreachable',
			url: cacheHref,
			lastProbe: key.lastProbe,
			worker: options.tenantScriptName,
			...(key.lastStatus !== undefined && { lastStatus: key.lastStatus }),
			...(key.lastRay !== undefined && { lastRay: key.lastRay })
		};
	}

	const subjectToken =
		first === undefined ? await identityToken?.() : undefined;
	const access =
		first?.access ??
		(subjectToken === undefined
			? undefined
			: await cacheClient.cacheAccess(subjectToken));

	return {
		kind: 'ready',
		url,
		slug,
		...(first === undefined && access !== undefined && { access }),
		cacheUrl,
		publicKey: key.value,
		...(first !== undefined && {
			created: { access: first.access, read: first.read }
		})
	};
}

async function resolveDeploymentUrl(
	options: OnboardOptions
): Promise<string | undefined> {
	const url = await deploymentUrl(
		options.api,
		options.controlScriptName,
		options.domain
	);

	if (url === undefined || options.domain !== undefined) {
		return url;
	}
	await options.ui.reporter().phase('Enabling the workers.dev route', () =>
		options.api.setWorkersDevRoutes(options.controlScriptName, {
			workersDev: true,
			previewUrls: true
		})
	);

	return url;
}

// The raw endpoints come from the hand-written client; each control call
// builds a derived client bound to the token issued earlier in the flow.
function onboardClientFor(url: string, signal?: AbortSignal): OnboardClient {
	const parsed = parseWorkerUrl(url);
	const raw = CupboardClient.fromUrl(parsed, {
		cache: { kind: 'default' },
		signal
	});
	const control = (credential: AccessCredential) =>
		controlRpc(parsed, { credential, signal });

	return {
		cacheAccess: async (subjectToken) => {
			try {
				const token = await raw.tokenExchange(
					subjectToken,
					subjectTokenTypeIdToken
				);
				const cache = await tenantRpc(parsed, {
					credential: token.access_token,
					signal
				}).caches.get.inDefaultCache({});
				return cache.access;
			} catch (error) {
				if (
					error instanceof CupboardHttpError &&
					error.oauthError?.problem === subjectTokenProblems.untrusted
				) {
					return;
				}
				const refusedStatuses: readonly number[] = [
					StatusCodes.UNAUTHORIZED,
					StatusCodes.FORBIDDEN
				];
				if (
					(error instanceof CupboardHttpError || error instanceof ORPCError) &&
					refusedStatuses.includes(error.status)
				) {
					return;
				}
				throw error;
			}
		},
		version: () => raw.version(),
		publicKey: () => raw.publicKey(),
		signup: (request) => raw.signup(request),
		tokenExchange: (subjectToken, subjectTokenType) =>
			raw.tokenExchange(subjectToken, subjectTokenType),
		initialiseInstance: (credential, name) =>
			control(credential).instance.initialise({ name }),
		getInstance: (credential) => control(credential).instance.get(),
		listTenants: (credential) => control(credential).tenants.list(),
		createTenant: (credential, body) =>
			control(credential).tenants.create(body),
		rebuildMembership: (credential) => control(credential).membership.rebuild(),
		controlCheck: (credential) => control(credential).check()
	};
}

function describeR2Check(check: R2CredentialCheck): string {
	return check.result === 'rejected'
		? `HTTP ${String(check.status)}`
		: check.result;
}

/**
 * Verifies the R2 credentials stored as Worker secrets, which cannot be read
 * back. A failed check prompts for a replacement, verifies it directly against
 * R2, stores it, and repeats the Worker check. Only a missing check procedure
 * identifies an older deployment; authentication and server failures propagate.
 * Bad credentials remain warnings because the cache can still serve reads.
 */
async function ensureWorkerR2(dependencies: {
	readonly ui: DeployUi;
	readonly api: CloudflareApi;
	readonly client: OnboardClient;
	readonly credential: AccessCredential;
	readonly r2: Extract<OnboardR2, { kind: 'kept' }>;
	readonly tenantScriptName: ScriptName;
	readonly check: typeof checkR2Credentials;
	readonly attempts: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly signal?: AbortSignal;
}): Promise<void> {
	const { ui, client, credential, r2 } = dependencies;
	let report: R2CredentialCheck;

	throwIfAborted(dependencies.signal);

	try {
		report = await ui
			.reporter()
			.phase('Checking the R2 credentials on the Worker', async (context) => {
				const answered = await client.controlCheck(credential);
				context.fact('r2', describeR2Check(answered.r2));

				return answered.r2;
			});
	} catch (error) {
		// An older deployment has no check route; the credentials stay
		// unproven.
		if (isRpcNotFoundError(error)) {
			ui.warn(
				`Could not check the R2 credentials (the deployment returned ` +
					`HTTP ${String(error.status)}).`
			);

			return;
		}

		throw error;
	}

	if (report.result === 'ok' || report.result === 'no-tenant') {
		return;
	}

	ui.warn(
		report.result === 'unconfigured'
			? 'The Worker has no R2 credentials bound, so pushes will fail.'
			: `R2 rejected the credentials on the Worker ` +
					`(HTTP ${String(report.status)}), so pushes will fail.`
	);

	for (;;) {
		throwIfAborted(dependencies.signal);

		const pair = await promptR2CredentialPair(ui, r2.accountId);

		if (pair === undefined) {
			ui.info(
				'The credentials are unchanged. Re-run `cupboard init` to replace ' +
					'them later.'
			);

			return;
		}

		const probe = await ui
			.reporter()
			.phase('Checking the new pair against R2', () =>
				dependencies.check({
					accountId: r2.accountId,
					bucketName: r2.bucketName,
					credentials: pair
				})
			);

		if (probe.kind === 'rejected') {
			ui.warn(
				`R2 rejected that pair too (HTTP ${String(probe.status)}); ` +
					'check the values and try again.'
			);
			continue;
		}

		if (probe.kind === 'unreachable') {
			ui.warn(
				'Could not reach R2 to check the pair. The Worker credentials were not changed.'
			);

			return;
		}

		if (probe.kind === 'invalid-response') {
			ui.warn(
				`${probe.cause.message} The Worker credentials were not changed.`
			);

			return;
		}

		await ui
			.reporter()
			.phase('Setting the new credentials on the Worker', async () => {
				await dependencies.api.putSecret(dependencies.tenantScriptName, {
					name: 'R2_ACCESS_KEY_ID',
					text: pair.accessKeyId
				});
				await dependencies.api.putSecret(dependencies.tenantScriptName, {
					name: 'R2_SECRET_ACCESS_KEY',
					text: pair.secretAccessKey
				});
			});

		// The Durable Object keeps its old env until it restarts on the new
		// Worker version, so the deployment may answer with the old pair for
		// a little while.
		const settled = await pollProbe(
			ui,
			'Waiting for the Worker to pick up the new credentials',
			dependencies.attempts,
			dependencies.sleep,
			dependencies.signal,
			async () => {
				const report = await client.controlCheck(credential);
				const checked = report.r2;

				return checked.result === 'ok'
					? { kind: 'ready', value: undefined }
					: { kind: 'retry', detail: describeR2Check(checked) };
			}
		);

		if (settled.kind === 'ready') {
			ui.success('The R2 credentials on the Worker are working.');
		} else {
			ui.warn(
				'The new credential pair is stored and valid in R2, but the Worker ' +
					'still uses the previous credentials. Allow the deployment to ' +
					'propagate, then re-run `cupboard init`.'
			);
		}

		return;
	}
}

const forbiddenStatus: number = StatusCodes.FORBIDDEN;
const conflictStatus: number = StatusCodes.CONFLICT;
const badRequestStatus: number = StatusCodes.BAD_REQUEST;
const tooManyRequestsStatus: number = StatusCodes.TOO_MANY_REQUESTS;
const serverErrorStatusCode: number = StatusCodes.INTERNAL_SERVER_ERROR;

/**
 * The advice for a failed claim, chosen by the status of the last response
 * from `/signup`.
 */
export type ClaimFailureAdvice =
	| 'fresh-secret'
	| 'already-claimed'
	| 'rejected-token'
	| 'rate-limited'
	| 'server-fault'
	| 'unexpected-status'
	| 'unreachable';

function claimFailureAdviceFor(status: number | undefined): ClaimFailureAdvice {
	switch (status) {
		case undefined: {
			return 'unreachable';
		}
		case forbiddenStatus: {
			return 'fresh-secret';
		}
		case conflictStatus: {
			return 'already-claimed';
		}
		case badRequestStatus: {
			return 'rejected-token';
		}
		case tooManyRequestsStatus: {
			return 'rate-limited';
		}
		default: {
			return status >= serverErrorStatusCode
				? 'server-fault'
				: 'unexpected-status';
		}
	}
}

function claimFailureAdviceText(url: URL, advice: ClaimFailureAdvice): string {
	switch (advice) {
		case 'fresh-secret': {
			return (
				'The claim secret did not take effect on the Worker in time. Re-run ' +
				'`cupboard init` to claim the deployment with a fresh claim secret.'
			);
		}
		case 'already-claimed': {
			return (
				'The deployment already has an admin. Log in as that admin with ' +
				`\`cupboard login ${url.origin}\`, adding \`--oidc-issuer\` and ` +
				'`--client-id` if the admin claimed the deployment with another ' +
				'issuer or client, and run `cupboard init` again to update the ' +
				'deployment.'
			);
		}
		case 'rejected-token': {
			return (
				'Log in with an issuer and client whose id_tokens `/signup` accepts, ' +
				'using `--oidc-issuer` and `--client-id`, then re-run `cupboard init`.'
			);
		}
		case 'rate-limited': {
			return (
				'Cloudflare limited the rate of requests to the deployment. Wait a ' +
				'few minutes, then re-run `cupboard init`.'
			);
		}
		case 'server-fault': {
			return 'The control Worker failed while it handled the claim.';
		}
		case 'unexpected-status': {
			return (
				`Check that ${url.origin} serves this release's control Worker, ` +
				'then re-run `cupboard init`.'
			);
		}
		case 'unreachable': {
			return (
				`The deploy could not reach ${url.origin}. Check that the ` +
				'deployment serves at that URL, then re-run `cupboard init`.'
			);
		}
	}
}

/**
 * The admin claim at `/signup` failed. `status` and `ray` come from the last
 * response from `/signup`, when there was one, and `status` selects `advice`.
 */
export class DeploymentClaimFailedError extends CliError {
	readonly advice: ClaimFailureAdvice;

	constructor(
		public readonly url: URL,
		public readonly detail: string,
		public readonly status: number | undefined,
		public readonly ray: string | undefined,
		options?: { readonly cause: unknown }
	) {
		const advice = claimFailureAdviceFor(status);

		super(
			`The admin claim failed: ${detail}. ${claimFailureAdviceText(url, advice)}`,
			options
		);
		this.name = 'DeploymentClaimFailedError';
		this.advice = advice;
	}
}

/**
 * The claim succeeded, but the admin session could not be cached on this
 * machine, so the steps that need an admin token cannot run.
 */
export class AdminSessionNotCachedError extends CliError {
	constructor(
		public readonly url: URL,
		public readonly admin: OwnerBinding,
		options: { readonly cause: unknown }
	) {
		const reason =
			options.cause instanceof Error ? ` (${options.cause.message})` : '';

		super(
			`The deployment is now administered by ${principalLabel(admin)}, but ` +
				`the admin session could not be cached on this machine${reason}. ` +
				`Log in with \`${adminLoginCommand(url, admin)}\` to cache it, then ` +
				're-run `cupboard init` to finish setting up the deployment.',
			options
		);
		this.name = 'AdminSessionNotCachedError';
	}
}

/**
 * The id_token presented at the claim belongs to a different identity from the
 * one that the operator confirmed before the upload.
 */
export class ClaimantChangedError extends CliError {
	constructor(
		public readonly confirmed: Claimant,
		public readonly presented: Principal | undefined
	) {
		const presentedText =
			presented === undefined
				? 'an id_token without an issuer and subject'
				: principalLabel(presented);

		super(
			'The login after the upload returned a different identity ' +
				`(${presentedText}) from the one that you confirmed ` +
				`(${principalLabel(confirmed)}), so the deployment was not ` +
				'claimed. Re-run `cupboard init` and log in as the identity that ' +
				'should become the admin.'
		);
		this.name = 'ClaimantChangedError';
	}
}

const claimSecretPropagationAttempts = 8;

/**
 * Claims the deployment for the operator: presents the claim secret with the
 * operator's id_token at `/signup`, which seeds the global admin and the
 * control trust rule from the token's issuer, subject and audience; deletes
 * the secret; and exchanges the same id_token for an admin token and caches it
 * for the other commands. The id_token must belong to the claimant that the
 * operator confirmed before the upload. The secret is deleted whether or not
 * the claim succeeds, because `/signup` accepts the secret from anyone for as
 * long as it is set. A failed delete produces a warning and leaves the claim's
 * outcome unchanged. A failure to cache the session after a successful claim is
 * reported with `AdminSessionNotCachedError`, not as a failed claim.
 *
 * Setting the secret after the upload creates a new Worker version of the same
 * release. Until that version serves, the version without the secret responds
 * with 403 and reports the same release at `/_version`. After each 403 the
 * deploy reads `/_version`. A 403 from a Worker that reports an earlier release
 * is retried for all of the claim's attempts. The version without the secret
 * and the version with it both report this release, so a 403 that reports this
 * release may still come from the version without the secret. The deploy
 * therefore allows eight such 403s before the claim counts as failed. The
 * attempts are four seconds apart, so the eighth arrives about 30 seconds
 * after the first.
 */
async function claimDeployment(dependencies: {
	readonly ui: DeployUi;
	readonly client: OnboardClient;
	readonly url: string;
	readonly claimSecret: ClaimSecret;
	readonly idToken: () => Promise<string>;
	readonly claimant: Claimant;
	readonly removeClaimSecret: () => Promise<void>;
	readonly buildVersion: string;
	readonly cacheSession: (session: CachedSession, target: URL) => Promise<void>;
	readonly attempts: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly signal?: AbortSignal;
}): Promise<OwnerBinding> {
	const { ui, client } = dependencies;
	let isSecretRemoved = false;

	try {
		const idToken = await dependencies.idToken();
		requireConfirmedClaimant(dependencies.claimant, idToken);
		const signup = await presentClaim(dependencies, idToken);

		// The secret has no use after `/signup`, so it is removed before the
		// session is cached.
		isSecretRemoved = true;
		await dependencies.removeClaimSecret();
		const admin = {
			issuer: signup.issuer,
			subject: signup.subject,
			audience: signup.audience
		};
		const target = parseWorkerUrl(dependencies.url);

		try {
			await ui.reporter().phase('Caching the admin session', async () => {
				const exchanged = await client.tokenExchange(
					idToken,
					subjectTokenTypeIdToken
				);

				await dependencies.cacheSession(
					sessionFromTokenResponse(exchanged),
					target
				);
			});
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}

			throw new AdminSessionNotCachedError(target, admin, { cause: error });
		}

		const name = ownDisplayName(idToken) ?? principalLabel(signup);
		ui.success(
			signup.claimed
				? `You are now the admin of this deployment (${name}).`
				: `You are already the admin of this deployment (${name}).`
		);

		return admin;
	} finally {
		if (!isSecretRemoved) {
			await dependencies.removeClaimSecret();
		}
	}
}

function requireConfirmedClaimant(confirmed: Claimant, idToken: string): void {
	const presented = principalOf(idToken);

	if (!isSamePrincipal(presented, confirmed)) {
		throw new ClaimantChangedError(confirmed, presented);
	}
}

// A 400 from `/signup` includes the server's reason in `error_description`,
// which the detail shows in full.
function claimResponseDetail(error: CupboardHttpError): string {
	const description = error.oauthError?.error_description;

	return description === undefined
		? httpDetail(error)
		: `HTTP ${String(error.status)}: ${description}`;
}

async function presentClaim(
	dependencies: Parameters<typeof claimDeployment>[0],
	idToken: string
): Promise<SignupResponse> {
	const { ui, client } = dependencies;
	const target = parseWorkerUrl(dependencies.url);
	const refusalsFromThisBuild = Math.min(
		dependencies.attempts,
		claimSecretPropagationAttempts
	);
	let forbiddenFromThisBuild = 0;
	// A failed `/_version` read does not count the 403, and the retry keeps the
	// status of the `/signup` response.
	const isReportingThisRelease = async (): Promise<boolean> => {
		try {
			return (await client.version()) === dependencies.buildVersion;
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}

			return false;
		}
	};

	try {
		const claim = await pollProbe(
			ui,
			'Claiming the deployment',
			dependencies.attempts,
			dependencies.sleep,
			dependencies.signal,
			async () => {
				try {
					const signup = await client.signup({
						subject_token: idToken,
						claim_secret: dependencies.claimSecret
					});

					return { kind: 'ready', value: signup };
				} catch (error) {
					// The client reports a network failure as `UnreachableHostError`.
					// The claim retries it, as DNS or routing may not have settled.
					if (error instanceof UnreachableHostError) {
						return { kind: 'retry', detail: 'unreachable' };
					}

					if (
						!(error instanceof CupboardHttpError) ||
						error.status !== forbiddenStatus
					) {
						throw error;
					}

					const refusal = {
						detail: claimResponseDetail(error),
						status: error.status
					};

					if (await isReportingThisRelease()) {
						forbiddenFromThisBuild += 1;
					}

					return forbiddenFromThisBuild >= refusalsFromThisBuild
						? { kind: 'stop', ...refusal }
						: { kind: 'retry', ...refusal };
				}
			}
		);

		if (claim.kind === 'gave-up') {
			throw new DeploymentClaimFailedError(
				target,
				claim.lastProbe,
				claim.lastStatus,
				claim.lastRay
			);
		}

		return claim.value;
	} catch (error) {
		if (error instanceof CupboardHttpError) {
			throw new DeploymentClaimFailedError(
				target,
				`${error.method} ${error.path} returned ${claimResponseDetail(error)}`,
				error.status,
				error.ray,
				{ cause: error }
			);
		}

		throw error;
	}
}

/**
 * The admin was claimed before migration 0016, and its bootstrap trust rule was
 * removed, so the deploy does not know the admin's audience. A new cache needs
 * the audience for its owner trust rule.
 */
export class OwnerAudienceUnknownError extends CliError {
	constructor(public readonly owner: OwnerBinding) {
		super(
			`The control database records no audience for the admin ` +
				`${principalLabel(owner)}, so the first cache cannot make the admin ` +
				'its owner. Create the cache with `cupboard tenant create`, passing ' +
				'`--owner-issuer`, `--owner-subject` and `--owner-audience`.'
		);
		this.name = 'OwnerAudienceUnknownError';
	}
}

interface FirstTenant extends CreatedCache {
	readonly tenant: TenantSummary;
}

/**
 * Ask for a slug and for access if none was supplied. If another caller claims
 * the slug first, ask for another slug and reuse the chosen access and read
 * credential.
 */
async function createFirstTenant(
	ui: DeployUi,
	client: OnboardClient,
	url: string,
	credential: AccessCredential,
	owner: Required<OwnerBinding>,
	requested: CacheAccessMode | undefined,
	read: TenantReadCredential
): Promise<FirstTenant | undefined> {
	let chosen = requested;

	for (;;) {
		const slug = await ui.prefixedText({
			message: 'Choose a slug for the first cache',
			prefix: `${url}/t/`,
			problem: slugProblemText
		});

		if (slug === undefined) {
			return undefined;
		}

		const access = chosen ?? (await chooseCacheAccess(ui));

		if (access === undefined) {
			return undefined;
		}

		chosen = access;

		try {
			const tenant = await ui.reporter().phase(`Creating ${slug}`, () =>
				client.createTenant(credential, {
					id: slug,
					defaultCacheAccess: access,
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience,
					read
				})
			);

			return { tenant, access, read };
		} catch (error) {
			if (error instanceof ORPCError && error.status === conflictStatusCode) {
				ui.warn(`"${slug}" is already taken; choose another.`);
				continue;
			}

			const status =
				error instanceof ORPCError || error instanceof CupboardHttpError
					? error.status
					: undefined;
			if (status === undefined || status === 408 || status >= 500) {
				showCacheCredential(
					ui,
					tenantUrl(parseWorkerUrl(url), slug),
					{ access, read },
					'unconfirmed'
				);
			}

			throw error;
		}
	}
}

function chooseCacheAccess(ui: DeployUi): Promise<CacheAccessMode | undefined> {
	return ui.menu<CacheAccessMode>('Who may read from this cache?', [
		{
			value: 'private',
			label: 'Only clients with a read credential',
			hint: 'private'
		},
		{
			value: 'public',
			label: 'Anyone who learns the URL',
			hint: 'public'
		}
	]);
}

async function pollProbe<T>(
	ui: DeployUi,
	label: string,
	attempts: number,
	sleep: ((ms: number) => Promise<void>) | undefined,
	signal: AbortSignal | undefined,
	probe: () => Promise<Probe<T>>
): Promise<
	| { readonly kind: 'ready'; readonly value: T }
	| {
			readonly kind: 'gave-up';
			readonly lastProbe: string;
			readonly lastStatus: number | undefined;
			readonly lastRay: string | undefined;
	  }
> {
	let ready: undefined | { value: T };
	let lastProbe = 'no answer';
	let lastStatus: number | undefined;
	let lastRay: string | undefined;

	await ui.reporter().phase(label, async (context) => {
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			throwIfAborted(signal);

			const probed = await attemptProbe(probe);

			if (probed.kind === 'ready') {
				ready = { value: probed.value };
				return;
			}

			lastProbe = probed.detail;
			lastStatus = probed.status;
			lastRay = probed.ray;

			if (probed.kind === 'stop') {
				return;
			}

			if (!(attempt < attempts)) {
				continue;
			}

			context.fact('attempt', attempt);
			context.fact('last probe', probed.detail);
			await delayMs(attemptDelayMs, { delay: sleep, signal });
		}
	});

	return ready === undefined
		? { kind: 'gave-up', lastProbe, lastStatus, lastRay }
		: { kind: 'ready', value: ready.value };
}

async function attemptProbe<T>(
	probe: () => Promise<Probe<T>>
): Promise<Probe<T>> {
	try {
		return await probe();
	} catch (error) {
		if (error instanceof CupboardHttpError) {
			const response = {
				detail: httpDetail(error),
				status: error.status,
				...(error.ray !== undefined && { ray: error.ray })
			};

			if (isRetryableStatus(error.status)) {
				return { kind: 'retry', ...response };
			}

			// A non-retryable 5xx is the server's own fault; stop and surface it.
			if (error.status >= serverErrorStatus) {
				return { kind: 'stop', ...response };
			}

			throw error;
		}

		// fetch throws TypeError while DNS or routing has not settled yet.
		if (error instanceof TypeError) {
			return { kind: 'retry', detail: 'unreachable' };
		}

		throw error;
	}
}

// The statuses worth waiting out: a route or DNS not yet live (404), the host
// busy (408, 429), or a transient gateway condition (502, 503, 504). A bare 500
// is the server's own fault, which retrying will not mend, so it is terminal.
const retryableStatuses = new Set<number>([
	StatusCodes.NOT_FOUND,
	StatusCodes.REQUEST_TIMEOUT,
	StatusCodes.TOO_MANY_REQUESTS,
	StatusCodes.BAD_GATEWAY,
	StatusCodes.SERVICE_UNAVAILABLE,
	StatusCodes.GATEWAY_TIMEOUT
]);

// Widened from the enum so the comparison against a numeric status stays number
// to number.
const serverErrorStatus: number = StatusCodes.INTERNAL_SERVER_ERROR;

function isRetryableStatus(status: number): boolean {
	return retryableStatuses.has(status);
}

function httpDetail(error: CupboardHttpError): string {
	const body = error.body.replaceAll(/\s+/g, ' ').trim();
	const compact = body.length <= 120 ? body : `${body.slice(0, 120)}…`;

	return compact === ''
		? `HTTP ${String(error.status)}`
		: `HTTP ${String(error.status)}: ${compact}`;
}
