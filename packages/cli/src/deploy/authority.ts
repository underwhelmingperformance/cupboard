import type { LocalStep } from '@cupboard/protocol/deployment';
import {
	oidcAudienceSchema,
	oidcIssuerSchema,
	oidcSubjectSchema,
	type TokenResponse
} from '@cupboard/protocol/oidc';
import { ORPCError } from '@orpc/client';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { isAbortError, throwIfAborted } from '../abort.ts';
import { type Audience, audienceSchema } from '../audience.ts';
import {
	cachedOwnerProvider,
	githubOidcTokenProvider,
	isAccessTokenExpired
} from '../auth/auth.ts';
import { decodeJwtPayload } from '../auth/jwt.ts';
import { type CachedSession, readCachedSession } from '../auth/token-store.ts';
import { CupboardClient } from '../client/client.ts';
import type { TokenProvider } from '../client/credentials.ts';
import {
	CliError,
	CupboardHttpError,
	OwnerLoginRequiredError,
	UnreachableHostError
} from '../errors.ts';
import { principalLabel } from '../principal.ts';

import { removeClaimSecret } from './claim-secret.ts';
import {
	type CloudflareApi,
	liveD1BindingSchema,
	type ScriptConfiguration
} from './cloudflare-api.ts';
import { jwtExpiryMs } from './cloudflare-oauth.ts';
import type { DeploymentConfig } from './config.ts';
import type { DeployOptions } from './deploy-run.ts';
import { deploymentUrl, recordedDeploymentUrl } from './deployment-url.ts';
import type { DatabaseId, ScriptName } from './identifiers.ts';
import {
	adminLoginCommand,
	type Claimant,
	claimantLabel,
	claimantOf,
	cloudflareDashIssuer,
	isSamePrincipal,
	type OwnerBinding,
	type Principal,
	principalOf
} from './owner.ts';
import {
	type ClaimSecret,
	claimSecretName,
	generateClaimSecret
} from './secrets.ts';
import type { DeployUi } from './ui.ts';

/**
 * Who may change the deployment in this run, determined before any change:
 *
 * - `bootstrap`: the control database has no admin and this run has a
 *   terminal, so this run claims the deployment for the operator with a
 *   claim secret and the operator's id_token. `claimant` is the
 *   identity in that id_token, which becomes the admin;
 * - `unclaimed`: no admin and no terminal to log in from, so this run
 *   provisions and uploads but leaves the claim to a run with a terminal;
 * - `admin`: an admin exists, and this run has an admin token for it.
 */
export type DeployAuthority =
	| {
			readonly kind: 'bootstrap';
			readonly claimSecret: ClaimSecret;
			readonly idToken: () => Promise<string>;
			readonly claimant: Claimant;
	  }
	| { readonly kind: 'unclaimed' }
	| {
			readonly kind: 'admin';
			readonly admin: OwnerBinding;
			readonly access: AdminAccess;
	  };

/**
 * The authority for this run, or `declined` when the operator declined the
 * claim at the confirmation prompt.
 */
export type EstablishedAuthority =
	DeployAuthority | { readonly kind: 'declined' };

/**
 * The admin credential for a deployment URL: the session cached by
 * `cupboard login`, or a CI token exchanged through a control trust rule.
 * Each provider renews its token as it nears expiry, so the token stays valid
 * while the deploy migrates tenants.
 */
export interface AdminAccess {
	credentialFor(url: URL): TokenProvider;
	/**
	 * The admin session that this machine has stored for `url`, read without
	 * contacting `url`. Undefined when there is none.
	 */
	storedSessionFor(url: URL): Promise<CachedSession | undefined>;
}

/**
 * Creates the admin access for a deployment whose URL before this run is
 * `deploymentUrl`. The deploy requests a CI token whose audience is that URL
 * at every URL that the deploy contacts, because the workflow's control trust
 * rule pins one audience.
 */
export type AdminAccessFactory = (deploymentUrl: URL) => AdminAccess;

const unauthorisedStatus: number = StatusCodes.UNAUTHORIZED;
const forbiddenStatus: number = StatusCodes.FORBIDDEN;
const badRequestStatus: number = StatusCodes.BAD_REQUEST;
const notFoundStatus: number = StatusCodes.NOT_FOUND;

function isRefusedStatus(status: number): boolean {
	return status === unauthorisedStatus || status === forbiddenStatus;
}

function tokenProblemText(url: URL, cause: unknown): string {
	if (cause instanceof OwnerLoginRequiredError) {
		return `no admin session for ${url.origin} is cached on this machine`;
	}

	if (cause instanceof AdminGrantMissingError) {
		return 'the token does not include the wildcard grant';
	}

	if (cause instanceof CupboardHttpError && cause.oauthError !== undefined) {
		return (
			'the token exchange was refused: ' +
			(cause.oauthError.error_description ?? cause.oauthError.error)
		);
	}

	if (cause instanceof CupboardHttpError || cause instanceof ORPCError) {
		return `${url.origin} refused the token (HTTP ${String(cause.status)})`;
	}

	return 'no usable token was found';
}

const ciUpdateAdvice =
	'or in CI pass `--github-oidc` with a control trust rule that gives the ' +
	'workflow the wildcard grant (see "Updating from CI" in the deployment ' +
	'guide, docs/deploying.md)';

export class AdminTokenRequiredError extends CliError {
	/**
	 * True when the run logged in as the admin at a terminal before this
	 * refusal.
	 */
	readonly isAfterLogin: boolean;

	constructor(
		public readonly url: URL,
		public readonly admin: OwnerBinding,
		options: { readonly cause: unknown; readonly isAfterLogin?: boolean }
	) {
		const advice =
			options.isAfterLogin === true &&
			options.cause instanceof AdminGrantMissingError
				? 'The login as the admin succeeded, so the control trust rule for ' +
					'the admin no longer gives the wildcard grant. Give it back with ' +
					'`cupboard control-oidc-trust`, then re-run `cupboard init`'
				: `Log in as the admin with \`${adminLoginCommand(url, admin)}\` ` +
					`and re-run \`cupboard init\`, ${ciUpdateAdvice}`;

		super(
			`This deployment is administered by ${principalLabel(admin)}. ` +
				'Updating it needs an admin token, and ' +
				`${tokenProblemText(url, options.cause)}. ${advice}. Nothing was ` +
				'changed.',
			{ cause: options.cause }
		);
		this.name = 'AdminTokenRequiredError';
		this.isAfterLogin = options.isAfterLogin === true;
	}
}

/**
 * The plan leaves the deployment without a URL, for example by removing its
 * custom domain on an account without a workers.dev subdomain.
 */
export class AdminNewUrlMissingError extends CliError {
	constructor(public readonly admin: OwnerBinding) {
		super(
			`This deployment is administered by ${principalLabel(admin)}, and the ` +
				'plan leaves it without a URL, so the deploy would not be able to ' +
				'migrate tenants or initialise the instance after the upload. Keep a ' +
				'custom domain in the plan, or register a workers.dev subdomain in ' +
				'the Cloudflare dashboard (Workers & Pages), then re-run ' +
				'`cupboard init`. Nothing was changed.'
		);
		this.name = 'AdminNewUrlMissingError';
	}
}

/**
 * A session stored for a URL was issued by a different deployment.
 */
export class StoredSessionMismatchError extends CliError {
	constructor() {
		super('the stored session was issued by a different deployment');
		this.name = 'StoredSessionMismatchError';
	}
}

export class AdminDeploymentUrlMissingError extends CliError {
	constructor(public readonly admin: OwnerBinding) {
		super(
			`This deployment is administered by ${principalLabel(admin)}, but it ` +
				'has no URL to check an admin token against. Register a ' +
				'workers.dev subdomain in the Cloudflare dashboard (Workers & ' +
				'Pages) or route a custom domain to the control Worker, then ' +
				're-run `cupboard init`. Nothing was changed.'
		);
		this.name = 'AdminDeploymentUrlMissingError';
	}
}

/**
 * Which of the two databases records the admin when the plan selects a
 * database other than the deployed Workers' database.
 */
export type AdminRecordedIn = 'bound' | 'planned' | 'both';

/**
 * The plan selects a D1 database other than the database of the deployed
 * Workers, and one of the two databases records an admin. Deploying would
 * either run as a first deploy while a database records an admin, or leave
 * the admin in a database that the Workers are no longer bound to.
 */
export class AdminDatabaseMismatchError extends CliError {
	constructor(
		public readonly boundDatabase: string | undefined,
		public readonly plannedDatabase: string | undefined,
		public readonly admin: OwnerBinding,
		public readonly recordedIn: AdminRecordedIn
	) {
		const bound = boundDatabase ?? 'no control database';
		const planned = plannedDatabase ?? 'no control database';
		const recorder = {
			bound: `the D1 database ${bound} records`,
			planned: `the D1 database ${planned} records`,
			both: 'both databases record'
		}[recordedIn];

		super(
			`The plan selects the D1 database ${planned}, but the deployed ` +
				`Workers use ${bound}, and ${recorder} the admin ` +
				`${principalLabel(admin)}. Select ${bound} in the plan, or bind ` +
				'the control Worker to the selected database first, as described under ' +
				'"Changing the control database" in the deployment guide ' +
				'(docs/deploying.md). Nothing was changed.'
		);
		this.name = 'AdminDatabaseMismatchError';
	}
}

/**
 * The control Worker no longer exists, but a control database records an
 * admin. No Worker can check an admin token, so the deploy cannot update the
 * deployment until the control Worker is redeployed.
 */
export class AdminControlWorkerMissingError extends CliError {
	constructor(
		public readonly admin: OwnerBinding,
		public readonly controlScriptName: string
	) {
		super(
			`This deployment is administered by ${principalLabel(admin)}, but ` +
				`its control Worker ${controlScriptName} no longer exists, so no ` +
				'Worker can check an admin token. Redeploy the control Worker with ' +
				'Wrangler, as described under "If the control Worker was deleted" ' +
				'in the deployment guide (docs/deploying.md), then re-run ' +
				'`cupboard init`. Nothing was changed.'
		);
		this.name = 'AdminControlWorkerMissingError';
	}
}

/**
 * The plan moves the deployment to another URL, and this machine has no
 * usable admin token for that URL. The new URL does not serve the deployment
 * until this run moves the deployment there, so the deploy cannot obtain a
 * token from the new URL beforehand.
 */
export class AdminTokenForNewUrlRequiredError extends CliError {
	constructor(
		public readonly url: URL,
		public readonly newUrl: URL,
		public readonly admin: OwnerBinding,
		options?: { readonly cause?: unknown }
	) {
		super(
			`The plan moves the deployment from ${url.origin} to ${newUrl.origin}, ` +
				`and an admin token for ${url.origin} is not accepted at ` +
				`${newUrl.origin}. This machine has no usable admin session for ` +
				`${newUrl.origin}, so migrating tenants and initialising the ` +
				'instance there after the upload would fail. ' +
				`Route ${newUrl.host} to the control Worker in the Cloudflare ` +
				`dashboard, log in as ${principalLabel(admin)} with ` +
				`\`${adminLoginCommand(newUrl, admin)}\`, and re-run ` +
				'`cupboard init`. Nothing was changed.',
			options
		);
		this.name = 'AdminTokenForNewUrlRequiredError';
	}
}

/**
 * Why the deploy could not check an admin token against the deployment: it
 * could not reach the deployment, the deployment answered with an error
 * status, the URL does not serve a Cupboard build, or the deployment's build
 * has no `instance.get` procedure.
 */
export type AdminCheckFailure =
	| { readonly kind: 'unreachable' }
	| {
			readonly kind: 'error-status';
			readonly status: number;
			readonly ray?: string;
	  }
	| { readonly kind: 'not-served' }
	| { readonly kind: 'unsupported' };

/**
 * What an error from the admin check means: the token is unusable, the check
 * could not run against the deployment, or the error has another cause and is
 * rethrown unchanged.
 */
type AdminCheckError =
	| { readonly kind: 'token' }
	| { readonly kind: 'check'; readonly failure: AdminCheckFailure }
	| { readonly kind: 'other' };

// A missing session, a token without the wildcard grant, a 401 or 403, and an
// OAuth error from the token exchange mean that the token cannot be used. An
// unreachable host and any other HTTP status mean that the check could not
// run. A 404 is returned as `unsupported`, which the caller confirms with a
// `/_version` request.
function classifyAdminCheckError(error: unknown): AdminCheckError {
	if (
		error instanceof OwnerLoginRequiredError ||
		error instanceof AdminGrantMissingError
	) {
		return { kind: 'token' };
	}

	if (error instanceof UnreachableHostError) {
		return { kind: 'check', failure: { kind: 'unreachable' } };
	}

	if (error instanceof CupboardHttpError) {
		if (
			isRefusedStatus(error.status) ||
			(error.status === badRequestStatus && error.oauthError !== undefined)
		) {
			return { kind: 'token' };
		}

		return {
			kind: 'check',
			failure:
				error.status === notFoundStatus
					? { kind: 'unsupported' }
					: {
							kind: 'error-status',
							status: error.status,
							...(error.ray !== undefined && { ray: error.ray })
						}
		};
	}

	if (error instanceof ORPCError) {
		if (isRefusedStatus(error.status)) {
			return { kind: 'token' };
		}

		return {
			kind: 'check',
			failure:
				error.status === notFoundStatus
					? { kind: 'unsupported' }
					: { kind: 'error-status', status: error.status }
		};
	}

	return { kind: 'other' };
}

function adminCheckFailureText(
	url: URL,
	controlScriptName: string,
	failure: AdminCheckFailure
): string {
	switch (failure.kind) {
		case 'unreachable': {
			return (
				`${url.origin} could not be reached. Check that the control Worker ` +
				'serves at that URL, then re-run `cupboard init`'
			);
		}
		case 'error-status': {
			const ray =
				failure.ray === undefined ? '' : ` (Cloudflare ray ${failure.ray})`;

			return (
				`${url.origin} returned HTTP ${String(failure.status)}${ray}. Run ` +
				`\`wrangler tail ${controlScriptName}\` and re-run \`cupboard init\` ` +
				'to see the error, or restore a working version with ' +
				`\`wrangler rollback --name ${controlScriptName}\` and re-run ` +
				'`cupboard init`'
			);
		}
		case 'not-served': {
			return (
				`${url.origin} does not serve the control Worker. Check the ` +
				"Worker's workers.dev route or custom domain in the Cloudflare " +
				'dashboard, then re-run `cupboard init`'
			);
		}
		case 'unsupported': {
			return (
				`${url.origin} runs a build without the \`instance.get\` procedure. ` +
				'First update the deployment with a `cupboard` release that is newer ' +
				'than the deployed build and has that procedure, then re-run ' +
				'`cupboard init` with this release'
			);
		}
	}
}

/**
 * The deploy could not check the admin token because the deployment was
 * unreachable, answered with an error status, does not serve at its URL, or
 * has no `instance.get` procedure.
 */
export class AdminCheckFailedError extends CliError {
	constructor(
		public readonly url: URL,
		public readonly admin: OwnerBinding,
		public readonly failure: AdminCheckFailure,
		controlScriptName: string,
		options: { readonly cause: unknown }
	) {
		super(
			`This deployment is administered by ${principalLabel(admin)}, and ` +
				'the deploy could not check the admin token against it: ' +
				`${adminCheckFailureText(url, controlScriptName, failure)}. Nothing ` +
				'was changed.',
			options
		);
		this.name = 'AdminCheckFailedError';
	}
}

/**
 * The login as the admin returned an identity other than the admin.
 */
export class AdminLoginMismatchError extends CliError {
	constructor(
		public readonly admin: OwnerBinding,
		public readonly presented: Principal | undefined
	) {
		const presentedText =
			presented === undefined
				? 'an id_token without an issuer and subject'
				: principalLabel(presented);

		super(
			`The login returned ${presentedText}, which is not the admin ` +
				`${principalLabel(admin)} of this deployment. Log in to ` +
				`${admin.issuer} as the admin, switching to the admin's account in ` +
				'the browser first if needed, and re-run `cupboard init`. Nothing ' +
				'was changed.'
		);
		this.name = 'AdminLoginMismatchError';
	}
}

/**
 * Returns the login that an update at a terminal uses when no usable admin
 * session is cached. It always starts a new login through the admin's issuer,
 * so the operator can complete it as a different identity from the cached
 * Cloudflare login. It refuses an id_token for any identity other than the
 * admin, then exchanges the id_token and caches the session, as
 * `cupboard login` does. The admin's audience is the client id of the login.
 */
export function adminLogin(dependencies: {
	readonly info: (message: string) => void;
	readonly login: (issuer: string, clientId: string) => Promise<string>;
	readonly exchange: (url: URL, idToken: string) => Promise<TokenResponse>;
	readonly cacheSession: (response: TokenResponse, url: URL) => Promise<void>;
	readonly defaultClientId: string;
}): (url: URL, admin: OwnerBinding) => Promise<void> {
	return async (url, admin) => {
		const separateLogin =
			admin.issuer === cloudflareDashIssuer
				? ' This is a new Cloudflare login, separate from the cached one, ' +
					'so you can log in as a different Cloudflare user.'
				: '';

		dependencies.info(
			`No usable admin session for ${url.origin}. Log in through ` +
				`${admin.issuer} as the admin ${principalLabel(admin)}.${separateLogin}`
		);

		const idToken = await dependencies.login(
			admin.issuer,
			admin.audience ?? dependencies.defaultClientId
		);
		const presented = principalOf(idToken);

		if (!isSamePrincipal(presented, admin)) {
			throw new AdminLoginMismatchError(admin, presented);
		}

		await dependencies.cacheSession(
			await dependencies.exchange(url, idToken),
			url
		);
	};
}

export class AdminGrantMissingError extends CliError {
	constructor() {
		super('the token does not include the wildcard grant');
		this.name = 'AdminGrantMissingError';
	}
}

/**
 * The control database that the deployed Workers are bound to, identified by
 * the binding's database id.
 */
export interface BoundDatabase {
	readonly id: DatabaseId;
	readonly name: string | undefined;
}

/**
 * The facts about the deployment and the plan that decide who may change it.
 */
export interface AuthorityDeployment {
	/**
	 * The database that the deployed Workers are bound to: the control Worker's
	 * binding, or the tenant Worker's binding when the control Worker was
	 * deleted. Undefined when neither Worker has the binding.
	 */
	readonly boundDatabase: BoundDatabase | undefined;
	/**
	 * The name of the control database selected in the plan.
	 */
	readonly plannedDatabaseName: string | undefined;
	readonly controlScriptName: string;
	/**
	 * Whether the control Worker exists on the account.
	 */
	readonly isControlDeployed: boolean;
	/**
	 * Whether this run has a terminal, so the operator can log in.
	 */
	readonly interactive: boolean;
}

/**
 * The reads, requests and logins that deciding the authority performs.
 */
export interface AuthorityEffects {
	readonly api: Pick<CloudflareApi, 'findD1Database' | 'd1QueryRows'>;
	/**
	 * True when a `/_version` request to `url` succeeds, and false when the host
	 * cannot be reached or does not serve Cupboard. Any other failure throws.
	 */
	readonly servesCupboard: (url: URL) => Promise<boolean>;
	/**
	 * Logs the operator in as `admin` and caches the session for `url`, as
	 * `cupboard login` does. Absent when the run cannot log in, for example
	 * with `--github-oidc`.
	 */
	readonly logInAsAdmin?: (url: URL, admin: OwnerBinding) => Promise<void>;
	/**
	 * The URL that the deployment serves on before this run changes anything.
	 */
	readonly currentUrl: () => Promise<URL | undefined>;
	/**
	 * The URL that the deploy uses after the upload to migrate tenants and to
	 * initialise the instance.
	 */
	readonly newUrl: () => Promise<URL | undefined>;
	readonly adminAccess: AdminAccessFactory;
	/**
	 * Checks that the deployment accepts the credential.
	 */
	readonly checkAdmin: (url: URL, credential: TokenProvider) => Promise<void>;
	/**
	 * An id_token for the operator. The token can be one from an earlier call.
	 */
	readonly idToken: () => Promise<string>;
	readonly generateClaimSecret: () => ClaimSecret;
	readonly now?: () => number;
	readonly signal?: AbortSignal;
}

/**
 * Decides who may change the deployment and, for an update, obtains and
 * checks the admin token. Nothing here changes the account, so a refusal
 * leaves the deployment as it was.
 *
 * The admin is read from the database that the deployed Workers are bound to
 * and from the database selected in the plan. When the two differ and either
 * records an admin, the deploy refuses: without the refusal, it could run as a
 * first deploy while a database records an admin, or leave the admin in a
 * database that the Workers are no longer bound to.
 *
 * Whether the deploy claims or updates the deployment depends on the
 * `global_admin` row, not on whether Workers are deployed. A deployment
 * uploaded without a claim, or one whose deploy stopped between setting the
 * claim secret and claiming, has Workers but no admin, and the next run from a
 * terminal claims it with a fresh secret.
 */
export async function decideAuthority(
	deployment: AuthorityDeployment,
	effects: AuthorityEffects
): Promise<DeployAuthority> {
	throwIfAborted(effects.signal);

	const bound = deployment.boundDatabase;
	const plannedName = deployment.plannedDatabaseName;
	const plannedId =
		plannedName === undefined
			? undefined
			: await effects.api.findD1Database(plannedName);
	const isSameDatabase = bound?.id === plannedId;
	const plannedAdmin = await adminRecordedIn(effects, plannedId);
	const boundAdmin = isSameDatabase
		? plannedAdmin
		: await adminRecordedIn(effects, bound?.id);
	const admin = boundAdmin ?? plannedAdmin;

	if (admin === undefined) {
		return firstDeployAuthority(deployment, effects);
	}

	if (!isSameDatabase) {
		throw new AdminDatabaseMismatchError(
			bound?.name,
			plannedName,
			admin,
			recordedIn(boundAdmin, plannedAdmin)
		);
	}

	if (!deployment.isControlDeployed) {
		throw new AdminControlWorkerMissingError(
			admin,
			deployment.controlScriptName
		);
	}

	const url = await effects.currentUrl();

	if (url === undefined) {
		throw new AdminDeploymentUrlMissingError(admin);
	}

	const access = effects.adminAccess(url);
	await checkAdminToken(deployment, effects, access, url, admin);

	const newUrl = await effects.newUrl();

	if (newUrl === undefined) {
		throw new AdminNewUrlMissingError(admin);
	}

	if (newUrl.origin === url.origin) {
		return { kind: 'admin', admin, access };
	}

	// A new URL that already serves Cupboard is checked live, as the current URL
	// is. A domain routed to the control Worker in the dashboard serves before
	// the deploy records it as the deployment's URL.
	if (await effects.servesCupboard(newUrl)) {
		await checkAdminToken(deployment, effects, access, newUrl, admin);
	} else {
		await requireStoredAdminToken(effects, access, newUrl, (cause) => {
			return new AdminTokenForNewUrlRequiredError(url, newUrl, admin, {
				cause
			});
		});
	}

	return { kind: 'admin', admin, access };
}

function recordedIn(
	boundAdmin: OwnerBinding | undefined,
	plannedAdmin: OwnerBinding | undefined
): AdminRecordedIn {
	if (boundAdmin !== undefined && plannedAdmin !== undefined) {
		return 'both';
	}

	return boundAdmin === undefined ? 'planned' : 'bound';
}

async function adminRecordedIn(
	effects: Pick<AuthorityEffects, 'api'>,
	databaseId: DatabaseId | undefined
): Promise<OwnerBinding | undefined> {
	if (databaseId === undefined) {
		return undefined;
	}

	const { api } = effects;

	return readGlobalAdmin(
		{ queryRows: (id, sql) => api.d1QueryRows(id, sql) },
		databaseId
	);
}

async function firstDeployAuthority(
	deployment: Pick<AuthorityDeployment, 'interactive'>,
	effects: Pick<AuthorityEffects, 'idToken' | 'generateClaimSecret'>
): Promise<DeployAuthority> {
	if (!deployment.interactive) {
		return { kind: 'unclaimed' };
	}

	// Log in before anything changes, so a refused or cancelled login, or an
	// id_token that `/signup` would refuse, leaves the account untouched.
	const idToken = await effects.idToken();
	const claimant = claimantOf(idToken);

	return {
		kind: 'bootstrap',
		claimSecret: effects.generateClaimSecret(),
		idToken: effects.idToken,
		claimant
	};
}

// Checks the admin token against the deployment at `url`. At a terminal, a
// token that cannot be used leads to one login as the admin, after which the
// check runs again. This covers a cached Cloudflare login whose exchange
// returned a session without the wildcard grant.
async function checkAdminToken(
	deployment: Pick<AuthorityDeployment, 'interactive' | 'controlScriptName'>,
	effects: AuthorityEffects,
	access: AdminAccess,
	url: URL,
	admin: OwnerBinding
): Promise<void> {
	const credential = access.credentialFor(url);
	const check = async (): Promise<void> => {
		requireWildcardGrant(await credential.get());
		await effects.checkAdmin(url, credential);
	};
	let isAfterLogin = false;

	try {
		try {
			await check();
		} catch (error) {
			const logIn = deployment.interactive ? effects.logInAsAdmin : undefined;

			if (
				logIn === undefined ||
				classifyAdminCheckError(error).kind !== 'token'
			) {
				throw error;
			}

			await logIn(url, admin);
			isAfterLogin = true;
			await check();
		}
	} catch (error) {
		if (isAbortError(error) || error instanceof AdminLoginMismatchError) {
			throw error;
		}

		const classified = classifyAdminCheckError(error);

		if (classified.kind === 'other') {
			throw error;
		}

		if (classified.kind === 'token') {
			throw new AdminTokenRequiredError(url, admin, {
				cause: error,
				isAfterLogin
			});
		}

		throw new AdminCheckFailedError(
			url,
			admin,
			await confirmedCheckFailure(effects, url, classified.failure),
			deployment.controlScriptName,
			{ cause: error }
		);
	}
}

// A 404 comes from a build without `instance.get` only when the URL serves a
// Cupboard build at all. Otherwise the URL does not serve the control Worker.
async function confirmedCheckFailure(
	effects: Pick<AuthorityEffects, 'servesCupboard'>,
	url: URL,
	failure: AdminCheckFailure
): Promise<AdminCheckFailure> {
	if (failure.kind !== 'unsupported') {
		return failure;
	}

	return (await effects.servesCupboard(url)) ? failure : { kind: 'not-served' };
}

// A session read from this machine and checked without contacting `url`,
// because nothing serves the deployment at `url` yet. The same rule applies as
// for the live check: the access token must come from the control issuer at
// `url` (its origin) and include the wildcard grant. An expired access token
// is accepted only with a refresh token, which the token provider uses to
// renew the access token once `url` serves. The deploy has already checked a
// token live at the current URL, so this check only makes sure that the steps
// after the upload can obtain a token for `url`.
async function requireStoredAdminToken(
	effects: Pick<AuthorityEffects, 'now'>,
	access: AdminAccess,
	url: URL,
	refuse: (cause: unknown) => Error
): Promise<void> {
	const session = await access.storedSessionFor(url);
	const now = effects.now ?? Date.now;

	if (
		session === undefined ||
		(session.refreshToken === undefined &&
			isAccessTokenExpired(session.accessToken, now()))
	) {
		throw refuse(undefined);
	}

	try {
		requireIssuer(session.accessToken, url);
		requireWildcardGrant(session.accessToken);
	} catch (error) {
		throw refuse(error);
	}
}

const issuerClaimSchema = z.looseObject({ iss: z.string() });

function requireIssuer(token: string, url: URL): void {
	const parsed = issuerClaimSchema.safeParse(decodeJwtPayload(token));

	if (!parsed.success || parsed.data.iss !== url.origin) {
		throw new StoredSessionMismatchError();
	}
}

const globalAdminColumnsQuery =
	"SELECT name FROM pragma_table_info('global_admin');";

// `queryRows` returns one string per row, so the row is read as a JSON array.
// Migration 0016 fills an unknown audience with an empty string, which the
// query reads as null.
const globalAdminQuery =
	"SELECT json_array(issuer, subject, NULLIF(audience, '')) FROM global_admin WHERE id = 'singleton';";

// Migration 0016 adds the `audience` column and fills it from the bootstrap
// trust rule. On a database without migration 0016, this query reads the
// audience from the same rule.
const globalAdminWithoutAudienceQuery =
	"SELECT json_array(issuer, subject, NULLIF((SELECT audience FROM control_trust WHERE id = 'signup'), '')) FROM global_admin WHERE id = 'singleton';";

const globalAdminRowSchema = z.tuple([
	z.string().min(1).pipe(oidcIssuerSchema),
	z.string().min(1).pipe(oidcSubjectSchema),
	z.string().min(1).pipe(oidcAudienceSchema).nullable()
]);

export class GlobalAdminRowInvalidError extends CliError {
	constructor(options?: { readonly cause?: unknown }) {
		super(
			'The global_admin row in D1 has an unexpected shape. Check the control database before retrying.',
			options
		);
		this.name = 'GlobalAdminRowInvalidError';
	}
}

/**
 * The deployment's global admin, read from the control database before any
 * migration runs. Undefined when nobody has claimed the deployment, or when
 * the database predates the `global_admin` table. The audience of an admin
 * claimed before migration 0016 comes from the bootstrap trust rule, and is
 * absent when that rule is missing.
 */
export async function readGlobalAdmin(
	api: {
		queryRows(databaseId: DatabaseId, sql: string): Promise<readonly string[]>;
	},
	databaseId: DatabaseId
): Promise<OwnerBinding | undefined> {
	const columns = await api.queryRows(databaseId, globalAdminColumnsQuery);

	if (columns.length === 0) {
		return undefined;
	}

	const [row] = await api.queryRows(
		databaseId,
		columns.includes('audience')
			? globalAdminQuery
			: globalAdminWithoutAudienceQuery
	);

	if (row === undefined) {
		return undefined;
	}

	let decoded: unknown;

	try {
		decoded = JSON.parse(row);
	} catch (error) {
		throw new GlobalAdminRowInvalidError({ cause: error });
	}

	const parsed = globalAdminRowSchema.safeParse(decoded);

	if (!parsed.success) {
		throw new GlobalAdminRowInvalidError();
	}

	const [issuer, subject, audience] = parsed.data;

	return audience === null
		? { issuer, subject }
		: { issuer, subject, audience };
}

const grantTypeSchema = z.looseObject({ type: z.string() });

const grantedDetailsSchema = z.object({
	authorization_details: z.array(grantTypeSchema)
});

// The deploy creates tenants, initialises the instance and migrates every
// tenant, so it needs the wildcard grant. The server still checks the token;
// this check stops a narrower token before any change.
function requireWildcardGrant(token: string): void {
	const parsed = grantedDetailsSchema.safeParse(decodeJwtPayload(token));

	if (
		!parsed.success ||
		parsed.data.authorization_details.every(
			(grant) => grant.type !== 'cupboard_wildcard'
		)
	) {
		throw new AdminGrantMissingError();
	}
}

// The claim's id_token only has to remain valid for the `/signup` and
// `/token` requests. A short margin keeps the id_token from the login before
// the upload in use, so the claim normally needs no second login, even with
// an issuer whose id_tokens are valid for only a few minutes.
const claimIdTokenMarginMs = 60 * 1000;

/**
 * An id_token source that logs in once, and logs in again only when the
 * current token expires within a minute. A first deploy logs in before
 * provisioning, and the claim can happen minutes later, after the token has
 * expired.
 */
export function renewingIdToken(
	login: () => Promise<string>,
	now: () => number = Date.now
): () => Promise<string> {
	let held: string | undefined;

	return async () => {
		const expiry = held === undefined ? undefined : jwtExpiryMs(held);

		if (
			held !== undefined &&
			(expiry === undefined || expiry > now() + claimIdTokenMarginMs)
		) {
			return held;
		}

		held = await login();

		return held;
	};
}

/**
 * Adds the claim secret to the control Worker's secrets on a first
 * deploy, so the claim can present it once the new build serves. For an
 * update or an unclaimed deploy, it returns the options unchanged.
 */
export function withClaimSecret(
	options: DeployOptions,
	authority: DeployAuthority
): DeployOptions {
	if (authority.kind !== 'bootstrap') {
		return options;
	}

	return {
		...options,
		secrets: {
			...options.secrets,
			control: [
				...options.secrets.control,
				{ name: claimSecretName, text: authority.claimSecret }
			]
		}
	};
}

/**
 * The function that migrates tenants during an update, with the admin access
 * that the update checked before any change. Only an admin creates tenants, so
 * a deployment without an admin has none, and the result is undefined for a
 * first deploy or an unclaimed deploy.
 */
export function tenantMigratorFor(
	authority: DeployAuthority,
	migrate: (access: AdminAccess, requiredStep: LocalStep) => Promise<void>
): ((requiredStep: LocalStep) => Promise<void>) | undefined {
	if (authority.kind !== 'admin') {
		return undefined;
	}

	return (requiredStep) => migrate(authority.access, requiredStep);
}

/**
 * Removes a claim secret that an earlier first deploy left on the control
 * Worker, which happens when that deploy was interrupted or could not delete
 * the secret. An update and a deploy without a terminal remove it; a first
 * deploy from a terminal sets and deletes its own secret. A failed removal
 * produces a warning, and the deploy continues.
 */
export async function removeLeftoverClaimSecret(
	authority: DeployAuthority,
	dependencies: {
		readonly ui: DeployUi;
		readonly api: Pick<CloudflareApi, 'deleteSecret'>;
		readonly controlScriptName: ScriptName;
		readonly controlSecrets: () => Promise<readonly string[]>;
	}
): Promise<void> {
	if (authority.kind === 'bootstrap') {
		return;
	}

	const secrets = await dependencies.controlSecrets();

	if (!secrets.includes(claimSecretName)) {
		return;
	}

	await removeClaimSecret(
		dependencies.ui,
		dependencies.api,
		dependencies.controlScriptName,
		'Removing a leftover claim secret'
	);
}

/**
 * Where an update's admin credential comes from: the session that
 * `cupboard login` cached for a URL, or a CI token exchanged through a control
 * trust rule.
 */
export interface AdminCredentialSources {
	readonly session: (url: URL) => TokenProvider;
	readonly storedSession: (url: URL) => Promise<CachedSession | undefined>;
	readonly githubOidc: (url: URL, audience: Audience) => TokenProvider;
}

export function adminCredentialSources(
	signal: AbortSignal | undefined
): AdminCredentialSources {
	return {
		session: (url) => cachedOwnerProvider(url, { signal }),
		storedSession: readCachedSession,
		githubOidc: (url, audience) =>
			githubOidcTokenProvider(
				CupboardClient.fromUrl(url, { cache: { kind: 'default' }, signal }),
				audience,
				[{ type: 'cupboard_wildcard' }]
			)
	};
}

/**
 * The admin credential for an update: a CI token exchanged through a control
 * trust rule with `--github-oidc`, otherwise the session cached by
 * `cupboard login`. Each origin has one provider, so every request to that
 * origin uses the token that the provider renews. With `--github-oidc`, the
 * deploy requests a GitHub token whose audience is `--audience`, or otherwise
 * the deployment URL from before this run, and `storedSessionFor` does not
 * read stored sessions.
 */
export function adminAccessFor(
	options: { readonly githubOidc?: boolean; readonly audience?: Audience },
	sources: AdminCredentialSources
): AdminAccessFactory {
	return (currentUrl) => {
		const providers = new Map<string, TokenProvider>();
		const audience = options.audience ?? audienceSchema.parse(currentUrl);
		const create = (url: URL): TokenProvider =>
			options.githubOidc === true
				? sources.githubOidc(url, audience)
				: sources.session(url);

		return {
			credentialFor: (url) => {
				const existing = providers.get(url.origin);

				if (existing !== undefined) {
					return existing;
				}

				const created = create(url);
				providers.set(url.origin, created);

				return created;
			},
			storedSessionFor: async (url) => {
				if (options.githubOidc === true) {
					return;
				}

				return sources.storedSession(url);
			}
		};
	};
}

// The Workers' binding for the control database, which records the admin.
const controlDatabaseBinding = 'CUPBOARD_DB';

function controlDatabaseName(config: DeploymentConfig): string | undefined {
	return config.control.d1Databases.find(
		(database) => database.binding === controlDatabaseBinding
	)?.databaseName;
}

function boundDatabaseId(
	configuration: ScriptConfiguration | undefined
): DatabaseId | undefined {
	return configuration?.bindings.flatMap((binding) => {
		const parsed = liveD1BindingSchema.safeParse(binding);

		return parsed.success && parsed.data.name === controlDatabaseBinding
			? [parsed.data.database_id]
			: [];
	})[0];
}

/**
 * The Cloudflare reads that determine who may change the deployment.
 */
export type AuthorityApi = Pick<
	CloudflareApi,
	| 'findD1Database'
	| 'findD1DatabaseName'
	| 'd1QueryRows'
	| 'findCustomDomain'
	| 'getWorkersDevSubdomain'
	| 'getScriptConfiguration'
>;

export interface AuthorityWorld {
	readonly ui: DeployUi;
	readonly api: AuthorityApi;
	readonly adminAccess: AdminAccessFactory;
	readonly checkAdmin: (url: URL, credential: TokenProvider) => Promise<void>;
	readonly servesCupboard: (url: URL) => Promise<boolean>;
	readonly logInAsAdmin?: (url: URL, admin: OwnerBinding) => Promise<void>;
	readonly idToken: () => Promise<string>;
	/**
	 * Asks whether the claim may make `claimant` the admin.
	 */
	readonly confirmClaim: (claimant: Claimant) => Promise<boolean>;
	readonly interactive: boolean;
	readonly signal?: AbortSignal | undefined;
}

/**
 * Determines who may change the deployment before anything changes, with the
 * rules of {@link decideAuthority}, and reports the result. The deployment's
 * current URL is the URL that the last deploy recorded on the control Worker.
 * A deployment from an earlier release has no record, and its current URL is
 * the custom domain routed to the control Worker, or the workers.dev URL. An
 * update checks its admin token against the current URL. When the plan moves
 * the deployment, the update also needs a token for the new URL: the deploy
 * checks it live if the new URL already serves the deployment, and otherwise
 * reads it from a session stored on this machine. A first deploy logs the
 * operator in with the issuer and client from `--oidc-issuer` and
 * `--client-id`, prints who the claim will make the admin, and asks for
 * confirmation.
 */
export async function establishAuthority(
	plans: {
		readonly agreed: {
			readonly config: DeploymentConfig;
			readonly domain: string | undefined;
		};
	},
	world: AuthorityWorld
): Promise<EstablishedAuthority> {
	const { ui, api } = world;
	const controlName = plans.agreed.config.control.name;
	const urlFor = async (
		domain: string | undefined
	): Promise<URL | undefined> => {
		const url = await deploymentUrl(api, controlName, domain);

		return url === undefined ? undefined : new URL(url);
	};
	const control = await api.getScriptConfiguration(controlName);
	// Without the control Worker, the tenant Worker's binding shows which
	// database the deployment used.
	const boundId = boundDatabaseId(
		control ??
			(await api.getScriptConfiguration(plans.agreed.config.tenant.name))
	);
	const recordedUrl =
		control === undefined ? undefined : recordedDeploymentUrl(control.bindings);

	// Not run inside a reporter phase, because a first deploy may open a
	// browser to log in.
	const authority = await decideAuthority(
		{
			boundDatabase:
				boundId === undefined
					? undefined
					: { id: boundId, name: await api.findD1DatabaseName(boundId) },
			plannedDatabaseName: controlDatabaseName(plans.agreed.config),
			controlScriptName: controlName,
			isControlDeployed: control !== undefined,
			interactive: world.interactive
		},
		{
			api,
			servesCupboard: world.servesCupboard,
			...(world.logInAsAdmin !== undefined && {
				logInAsAdmin: world.logInAsAdmin
			}),
			currentUrl: async () =>
				recordedUrl ?? urlFor(await api.findCustomDomain(controlName)),
			newUrl: () => urlFor(plans.agreed.domain),
			adminAccess: world.adminAccess,
			checkAdmin: world.checkAdmin,
			idToken: world.idToken,
			generateClaimSecret,
			...(world.signal !== undefined && { signal: world.signal })
		}
	);

	switch (authority.kind) {
		case 'admin': {
			ui.success(
				`Authorised to update the deployment administered by ${principalLabel(authority.admin)}`
			);
			break;
		}
		case 'bootstrap': {
			ui.info(
				'This deployment has no admin yet. Once it is deployed, the claim ' +
					`makes ${claimantLabel(authority.claimant)} its admin, and the ` +
					'claim cannot be undone. For the claim, the deploy sets a ' +
					`one-time secret, ${claimSecretName}, on the control Worker and ` +
					'removes it afterwards.'
			);

			if (!(await world.confirmClaim(authority.claimant))) {
				return { kind: 'declined' };
			}

			break;
		}
		case 'unclaimed': {
			ui.warn(
				'This deployment has no admin, and this run has no terminal to log ' +
					'in from. It will be deployed without an admin.'
			);
			break;
		}
	}

	return authority;
}
