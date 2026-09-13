import { createHash } from 'node:crypto';

import { tenantUrl } from '@cupboard/nix-store/cache-url';
import { cacheNamePattern } from '@cupboard/nix-store/scalars';
import { canonicalHref } from '@cupboard/nix-store/url';
import type {
	ConfiguredInstanceSummary,
	InstanceName,
	InstanceSummary
} from '@cupboard/protocol/instance';
import { instanceNameSchema } from '@cupboard/protocol/instance';
import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import type {
	ControlCheckReport,
	R2CredentialCheck
} from '@cupboard/protocol/reports';
import type {
	MembershipRebuildResponse,
	TenantCreateBodyInput,
	TenantListResponse,
	TenantSummary
} from '@cupboard/protocol/tenants';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';

import { delayMs, throwIfAborted } from '../abort.ts';
import {
	type CachedSession,
	sessionFromTokenResponse,
	writeCachedSession
} from '../auth/token-store.ts';
import { CupboardClient } from '../client/client.ts';
import { controlRpc } from '../client/orpc.ts';
import { isRpcNotFoundError } from '../client/rpc-errors.ts';
import { parseWorkerUrl } from '../client/transport.ts';
import { CupboardHttpError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import type { CloudflareAccountId, ScriptName } from './identifiers.ts';
import { deployerOwner, type OwnerBinding, type OwnerChoice } from './owner.ts';
import {
	checkR2Credentials,
	promptR2CredentialPair
} from './r2-credentials.ts';
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

export type OnboardAdmin =
	| {
			readonly kind: 'claimable';
			readonly owner: OwnerBinding;
			readonly idToken: string;
	  }
	| { readonly kind: 'other'; readonly owner: OwnerBinding }
	| {
			readonly kind: 'unproven';
			readonly owner: OwnerBinding;
	  }
	| { readonly kind: 'none' };

/**
 * The admin binding as the onboarding sees it: claimable right now when the
 * agreed binding is the deployer's own identity and the login included an
 * id_token to prove it; someone else's when the binding is a different
 * identity; unproven when the session's credential includes no identity at
 * all; or nobody's.
 */
export function onboardAdminFor(
	choice: OwnerChoice,
	deployer?: { readonly subject: string; readonly idToken: string }
): OnboardAdmin {
	if (choice.kind === 'none') {
		return { kind: 'none' };
	}

	if (deployer === undefined) {
		return { kind: 'unproven', owner: choice.owner };
	}

	const own = deployerOwner(deployer.subject);
	const isMatch =
		choice.owner.issuer === own.issuer &&
		choice.owner.subject === own.subject &&
		choice.owner.audience === own.audience;

	return isMatch
		? { kind: 'claimable', owner: choice.owner, idToken: deployer.idToken }
		: { kind: 'other', owner: choice.owner };
}

export type OnboardOutcome =
	| {
			readonly kind: 'ready';
			readonly url: string;
			readonly slug: string;
			readonly cacheUrl: URL;
			readonly publicKey: string;
	  }
	| { readonly kind: 'no-admin'; readonly url: string }
	| {
			readonly kind: 'admin-elsewhere';
			readonly url: string;
			readonly owner: OwnerBinding;
	  }
	| {
			readonly kind: 'identity-unproven';
			readonly url: string;
			readonly owner: OwnerBinding;
	  }
	| {
			readonly kind: 'claim-refused';
			readonly url: string;
			readonly status: number;
			readonly detail: string;
			readonly ray?: string;
	  }
	| { readonly kind: 'claim-cancelled'; readonly url: string }
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
 * serves, plus the control procedures in the contract's shapes. The tokens
 * arrive per call because they are issued mid-flow, after the client is
 * built; the default factory creates a derived client for each control call
 * and binds that call's token.
 */
export interface OnboardClient extends Pick<
	CupboardClient,
	'version' | 'signup' | 'tokenExchange' | 'publicKey'
> {
	getInstance(token: string): Promise<InstanceSummary>;
	initialiseInstance(
		token: string,
		name: InstanceName
	): Promise<ConfiguredInstanceSummary>;
	listTenants(token: string): Promise<TenantListResponse>;
	createTenant(
		token: string,
		body: TenantCreateBodyInput
	): Promise<TenantSummary>;
	rebuildMembership(token: string): Promise<MembershipRebuildResponse>;
	controlCheck(token: string): Promise<ControlCheckReport>;
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

/**
 * What the deploy knows about `CUPBOARD_SIGNUP_SECRET`, which takes precedence
 * over the admin binding. `known` includes the value supplied by this deploy;
 * `configured` means the Worker has an unreadable existing value; `none` means
 * the secret is absent.
 */
export type ClaimSecret =
	| { readonly kind: 'known'; readonly value: string }
	| { readonly kind: 'configured' }
	| { readonly kind: 'none' };

export interface OnboardOptions {
	readonly api: CloudflareApi;
	readonly ui: DeployUi;
	readonly controlScriptName: ScriptName;
	readonly tenantScriptName: ScriptName;
	readonly domain: string | undefined;
	readonly instanceName?: InstanceName;
	readonly admin: OnboardAdmin;
	readonly buildVersion: string;
	readonly claimSecret: ClaimSecret;
	readonly r2: OnboardR2;
	readonly signal?: AbortSignal;
	/**
	 * Fetches an id_token immediately before the claim. The token captured at
	 * login can expire during deployment, so the claim falls back to that token
	 * only when a refresh returns no replacement.
	 */
	readonly freshIdToken?: () => Promise<string | undefined>;
	readonly clientFactory?: (url: string) => OnboardClient;
	readonly cacheSession?: (
		session: CachedSession,
		target: URL
	) => Promise<void>;
	readonly checkCredentials?: typeof checkR2Credentials;
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
 * Then it is initialised: the deployer claims global admin with their id_token,
 * the admin token is cached for the other commands, a slug is chosen for the
 * first cache (the create call is the arbiter of slug ownership, so a conflict
 * re-prompts), and the new cache's `/pubkey` is polled, since the first
 * successful request creates the signing key.
 */
export async function onboardDeployment(
	options: OnboardOptions
): Promise<OnboardOutcome> {
	const { ui, admin } = options;
	const clientFactory =
		options.clientFactory ??
		((url: string) => onboardClientFor(url, options.signal));
	const cacheSession = options.cacheSession ?? writeCachedSession;
	const attempts = options.attempts ?? defaultAttempts;
	const signal = options.signal;

	throwIfAborted(signal);

	const resolved = await resolveDeploymentUrl(options);

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

	if (admin.kind === 'none') {
		return { kind: 'no-admin', url };
	}

	if (admin.kind === 'other') {
		return { kind: 'admin-elsewhere', url, owner: admin.owner };
	}

	if (admin.kind === 'unproven') {
		return { kind: 'identity-unproven', url, owner: admin.owner };
	}

	const secret = await resolveClaimSecret(ui, options.claimSecret);

	if (secret.kind === 'withheld') {
		return { kind: 'claim-cancelled', url };
	}

	const subjectToken = (await options.freshIdToken?.()) ?? admin.idToken;

	const claim = await claimAdmin(
		ui,
		client,
		url,
		{ idToken: subjectToken, claimSecret: secret.value },
		cacheSession
	);

	if (claim.kind === 'refused') {
		return {
			kind: 'claim-refused',
			url,
			status: claim.status,
			detail: claim.detail,
			...(claim.ray !== undefined && { ray: claim.ray })
		};
	}

	const currentInstance = await ui
		.reporter()
		.phase('Reading instance identity', () => client.getInstance(claim.token));
	const instanceName =
		options.instanceName ??
		(currentInstance.state === 'configured'
			? currentInstance.name
			: defaultInstanceName(url));

	await ui
		.reporter()
		.phase('Configuring instance identity', () =>
			client.initialiseInstance(claim.token, instanceName)
		);

	// Read before creating: a re-run against an initialised deployment must
	// skip the slug prompt, and several caches mean there is no "first".
	const existing = await ui
		.reporter()
		.phase('Checking existing caches', async () => {
			const listed = await client.listTenants(claim.token);

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
				const { tenants } = await client.rebuildMembership(claim.token);
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
	const sole = existing[0];

	if (sole === undefined) {
		const tenant = await createFirstTenant(
			ui,
			client,
			url,
			claim.token,
			admin.owner
		);

		if (tenant === undefined) {
			return { kind: 'cancelled', url };
		}

		slug = tenant.id;
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
			token: claim.token,
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

	return {
		kind: 'ready',
		url,
		slug,
		cacheUrl,
		publicKey: key.value
	};
}

/**
 * The URL the deployment serves on: the custom domain, or the script's
 * workers.dev hostname when the account has a subdomain registered. Purely a
 * lookup; enabling the workers.dev route is the onboarding's job.
 */
export async function deploymentUrl(
	api: CloudflareApi,
	controlScriptName: ScriptName,
	domain: string | undefined
): Promise<string | undefined> {
	if (domain !== undefined) {
		return `https://${domain}`;
	}

	const subdomain = await api.getWorkersDevSubdomain();

	return subdomain === undefined
		? undefined
		: `https://${controlScriptName}.${subdomain}.workers.dev`;
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
	const control = (token: string) =>
		controlRpc(parsed, { credential: token, signal });

	return {
		version: () => raw.version(),
		publicKey: () => raw.publicKey(),
		signup: (request) => raw.signup(request),
		tokenExchange: (subjectToken, subjectTokenType) =>
			raw.tokenExchange(subjectToken, subjectTokenType),
		initialiseInstance: (token, name) =>
			control(token).instance.initialise({ name }),
		getInstance: (token) => control(token).instance.get(),
		listTenants: (token) => control(token).tenants.list(),
		createTenant: (token, body) => control(token).tenants.create(body),
		rebuildMembership: (token) => control(token).membership.rebuild(),
		controlCheck: (token) => control(token).check()
	};
}

type ClaimResult =
	| { readonly kind: 'claimed'; readonly token: string }
	| {
			readonly kind: 'refused';
			readonly status: number;
			readonly detail: string;
			readonly ray?: string;
	  };

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
	readonly token: string;
	readonly r2: Extract<OnboardR2, { kind: 'kept' }>;
	readonly tenantScriptName: ScriptName;
	readonly check: typeof checkR2Credentials;
	readonly attempts: number;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly signal?: AbortSignal;
}): Promise<void> {
	const { ui, client, token, r2 } = dependencies;
	let report: R2CredentialCheck;

	throwIfAborted(dependencies.signal);

	try {
		report = await ui
			.reporter()
			.phase('Checking the R2 credentials on the Worker', async (context) => {
				const answered = await client.controlCheck(token);
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
				const report = await client.controlCheck(token);
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

/**
 * Resolves the claim secret used during signup. It reuses a value known to the
 * current deployment, prompts the operator when only the Worker has the
 * configured secret, or continues without a claim. Cancelling the prompt
 * returns `withheld`.
 */
async function resolveClaimSecret(
	ui: DeployUi,
	claimSecret: ClaimSecret
): Promise<
	| { readonly kind: 'settled'; readonly value: string | undefined }
	| { readonly kind: 'withheld' }
> {
	switch (claimSecret.kind) {
		case 'none': {
			return { kind: 'settled', value: undefined };
		}

		case 'known': {
			return { kind: 'settled', value: claimSecret.value };
		}

		case 'configured': {
			ui.info(
				'This deployment is protected by a claim secret ' +
					'(the CUPBOARD_SIGNUP_SECRET Worker secret), which must be ' +
					'presented to become the admin.'
			);

			const entered = await ui.secret('Enter the claim secret', (value) =>
				value === '' ? 'a value is required' : undefined
			);

			return entered === undefined
				? { kind: 'withheld' }
				: { kind: 'settled', value: entered };
		}
	}
}

/**
 * Claims global admin with the deployer's id_token (idempotent for the same
 * principal), exchanges it for an admin access token, and caches that token so
 * the admin commands work without a separate `cupboard login`. A refusal comes
 * back as a `refused` result rather than an exception, because by the time the
 * claim arrives the signup gate may name a different principal.
 */
async function claimAdmin(
	ui: DeployUi,
	client: OnboardClient,
	url: string,
	proof: { readonly idToken: string; readonly claimSecret: string | undefined },
	cacheSession: (session: CachedSession, target: URL) => Promise<void>
): Promise<ClaimResult> {
	let claim:
		| undefined
		| {
				readonly claimed: boolean;
				readonly subject: string;
				readonly token: string;
		  };

	try {
		claim = await ui.reporter().phase('Setting up admin access', async () => {
			const signup = await client.signup({
				subject_token: proof.idToken,
				...(proof.claimSecret !== undefined && {
					claim_secret: proof.claimSecret
				})
			});
			const exchanged = await client.tokenExchange(
				proof.idToken,
				subjectTokenTypeIdToken
			);

			await cacheSession(
				sessionFromTokenResponse(exchanged),
				parseWorkerUrl(url)
			);

			return {
				claimed: signup.claimed,
				subject: signup.subject,
				token: exchanged.access_token
			};
		});
	} catch (error) {
		if (error instanceof CupboardHttpError) {
			return {
				kind: 'refused',
				status: error.status,
				detail: `${error.method} ${error.path} answered ${httpDetail(error)}`,
				...(error.ray !== undefined && { ray: error.ray })
			};
		}

		throw error;
	}

	ui.success(
		claim.claimed
			? `You are now the admin of this deployment (${claim.subject}).`
			: `You are already the admin of this deployment (${claim.subject}).`
	);

	return { kind: 'claimed', token: claim.token };
}

/**
 * Prompts for a slug and creates the tenant. The server decides ownership
 * because another caller can claim the slug before this request arrives. If the
 * server reports a conflict, it prompts again. Recreating an identical tenant
 * is idempotent, so a rerun with the same slug returns the existing tenant.
 */
async function createFirstTenant(
	ui: DeployUi,
	client: OnboardClient,
	url: string,
	token: string,
	owner: OwnerBinding
): Promise<TenantSummary | undefined> {
	for (;;) {
		const slug = await ui.prefixedText({
			message: 'Choose a slug for the first cache',
			prefix: `${url}/t/`,
			problem: slugProblemText
		});

		if (slug === undefined) {
			return undefined;
		}

		try {
			return await ui.reporter().phase(`Creating ${slug}`, () =>
				client.createTenant(token, {
					id: slug,
					defaultCacheAccess: 'public',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience
				})
			);
		} catch (error) {
			if (error instanceof ORPCError && error.status === conflictStatusCode) {
				ui.warn(`"${slug}" is already taken; choose another.`);
				continue;
			}

			throw error;
		}
	}
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

			if (attempt < attempts) {
				context.fact('attempt', attempt);
				context.fact('last probe', probed.detail);
				await delayMs(attemptDelayMs, { delay: sleep, signal });
			}
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
