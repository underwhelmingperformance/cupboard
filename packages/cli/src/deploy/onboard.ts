import { setTimeout as delay } from 'node:timers/promises';

import { cacheNamePattern } from '@cupboard/nix/scalars';
import { subjectTokenTypeIdToken } from '@cupboard/protocol/oidc';
import type { ParsedTenantSummary } from '@cupboard/protocol/tenants';

import { writeCachedToken } from '../auth/token-store.ts';
import { CupboardClient } from '../client/client.ts';
import { CupboardHttpError } from '../errors.ts';

import type { CloudflareApi } from './cloudflare-api.ts';
import { deployerOwner, type OwnerBinding, type OwnerChoice } from './owner.ts';
import type { DeployUi } from './ui.ts';

/** What a single probe of the deployment concluded. */
type Probe<T> =
	| { readonly kind: 'ready'; readonly value: T }
	| { readonly kind: 'retry'; readonly detail: string };

/** How the agreed admin binding relates to the person deploying. */
export type OnboardAdmin =
	| {
			readonly kind: 'claimable';
			readonly owner: OwnerBinding;
			/** The deployer's id_token, the proof the server checks. */
			readonly idToken: string;
	  }
	| { readonly kind: 'other'; readonly owner: OwnerBinding }
	| {
			/** The session's credential carries no identity to prove a match. */
			readonly kind: 'unproven';
			readonly owner: OwnerBinding;
	  }
	| { readonly kind: 'none' };

/**
 * The admin binding as the onboarding sees it: claimable right now when the
 * agreed binding is the deployer's own identity and the login carried an
 * id_token to prove it; someone else's when it names a different identity;
 * unproven when the session's credential carries no identity at all; or
 * nobody's.
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
	const matches =
		choice.owner.issuer === own.issuer &&
		choice.owner.subject === own.subject &&
		choice.owner.audience === own.audience;

	return matches
		? { kind: 'claimable', owner: choice.owner, idToken: deployer.idToken }
		: { kind: 'other', owner: choice.owner };
}

export type OnboardOutcome =
	| {
			readonly kind: 'ready';
			/** The deployment's base URL (the control plane). */
			readonly url: string;
			readonly slug: string;
			/** The cache URL Nix talks to: `<url>/t/<slug>`. */
			readonly cacheUrl: string;
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
			/** The failing call and the server's own words. */
			readonly detail: string;
	  }
	| { readonly kind: 'claim-cancelled'; readonly url: string }
	| { readonly kind: 'cancelled'; readonly url: string }
	| {
			readonly kind: 'unreachable';
			readonly url: string;
			/** What the final probe saw, e.g. `HTTP 404` or `unreachable`. */
			readonly lastProbe: string;
	  }
	| { readonly kind: 'no-subdomain' };

/** The slice of {@link CupboardClient} the onboarding drives. */
export type OnboardClient = Pick<
	CupboardClient,
	'version' | 'signup' | 'tokenExchange' | 'createTenant' | 'publicKey'
>;

/**
 * What the deploy knows about the `CUPBOARD_SIGNUP_SECRET` Worker secret,
 * which takes precedence over the admin binding when set: the value itself
 * when this deploy supplied it, only that one exists, or nothing.
 */
export type ClaimSecret =
	| { readonly kind: 'known'; readonly value: string }
	| { readonly kind: 'configured' }
	| { readonly kind: 'none' };

export interface OnboardOptions {
	readonly api: CloudflareApi;
	readonly ui: DeployUi;
	/** The control Worker's script name, which serves the control plane. */
	readonly controlScriptName: string;
	readonly domain: string | undefined;
	readonly admin: OnboardAdmin;
	/** The version the uploaded Workers answer on `/_version`. */
	readonly buildVersion: string;
	readonly claimSecret: ClaimSecret;
	readonly clientFactory?: (url: string) => OnboardClient;
	readonly cacheToken?: (token: string, target: string) => Promise<void>;
	readonly sleep?: (ms: number) => Promise<void>;
	readonly attempts?: number;
}

const defaultAttempts = 30;
const attemptDelayMs = 4000;
const conflictStatusCode = 409;

/** Why `value` cannot be a tenant slug, or undefined when it can. */
export function slugProblem(value: string): string | undefined {
	if (value === '') {
		return 'a slug is required';
	}

	if (!cacheNamePattern.test(value)) {
		return (
			'use lowercase letters, digits, ".", "_" or "-", starting with a ' +
			'letter or digit (63 characters at most)'
		);
	}

	return undefined;
}

/**
 * Turns a deployed Worker into a usable cache, in two steps. First the
 * deployment must be up: its URL is resolved (the custom domain, or the
 * account's workers.dev subdomain with the script's route enabled) and the
 * unauthenticated `/_version` route polled until it answers with the version
 * just uploaded, since routing, DNS and the new Worker version all take time
 * to settle (an older version may still answer, with the old configuration).
 * Then it is initialised: the deployer claims global admin with their
 * id_token, the admin token is cached for the other commands, a slug is
 * chosen for the first cache (the create call is the arbiter of slug
 * ownership, so a conflict re-prompts), and the new cache's `/pubkey` is
 * polled, whose first success creates the signing key.
 */
export async function onboardDeployment(
	options: OnboardOptions
): Promise<OnboardOutcome> {
	const { ui, admin } = options;
	const clientFactory =
		options.clientFactory ?? ((url: string) => CupboardClient.fromUrl(url));
	const cacheToken = options.cacheToken ?? writeCachedToken;
	const sleep = options.sleep ?? ((ms: number) => delay(ms));
	const attempts = options.attempts ?? defaultAttempts;

	const resolved = await resolveDeploymentUrl(options);

	if (resolved === undefined) {
		return { kind: 'no-subdomain' };
	}

	const url = resolved;
	const client = clientFactory(url);

	const up = await pollProbe(
		ui,
		`Waiting for build ${options.buildVersion} to serve`,
		attempts,
		sleep,
		async () => {
			const live = await client.version();

			return live === options.buildVersion
				? { kind: 'ready', value: undefined }
				: { kind: 'retry', detail: `still serving ${live}` };
		}
	);

	if (up.kind === 'gave-up') {
		return { kind: 'unreachable', url, lastProbe: up.lastProbe };
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

	const claim = await claimAdmin(
		ui,
		client,
		url,
		{ idToken: admin.idToken, claimSecret: secret.value },
		cacheToken
	);

	if (claim.kind === 'refused') {
		return {
			kind: 'claim-refused',
			url,
			status: claim.status,
			detail: claim.detail
		};
	}

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

	const cacheUrl = `${url}/t/${tenant.id}`;
	const cacheClient = clientFactory(cacheUrl);

	const key = await pollProbe(
		ui,
		'Initialising the cache',
		attempts,
		sleep,
		async () => ({ kind: 'ready', value: await cacheClient.publicKey() })
	);

	if (key.kind === 'gave-up') {
		return { kind: 'unreachable', url: cacheUrl, lastProbe: key.lastProbe };
	}

	return {
		kind: 'ready',
		url,
		slug: tenant.id,
		cacheUrl,
		publicKey: key.value
	};
}

async function resolveDeploymentUrl(
	options: OnboardOptions
): Promise<string | undefined> {
	if (options.domain !== undefined) {
		return `https://${options.domain}`;
	}

	const subdomain = await options.api.getWorkersDevSubdomain();

	if (subdomain === undefined) {
		return undefined;
	}

	// With a custom domain the workers.dev route stays off: a private cache
	// gains nothing from a second public hostname.
	await options.ui
		.reporter()
		.phase('Enabling the workers.dev route', () =>
			options.api.enableWorkersDevRoute(options.controlScriptName)
		);

	return `https://${options.controlScriptName}.${subdomain}.workers.dev`;
}

type ClaimResult =
	| { readonly kind: 'claimed'; readonly token: string }
	| {
			readonly kind: 'refused';
			readonly status: number;
			readonly detail: string;
	  };

/**
 * Settles the claim secret the signup must present: the value this deploy
 * already knows, the one the operator types when only the Worker holds it,
 * or none at all. A dismissed prompt withholds the claim rather than sending
 * one that is sure to be refused.
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
 * the admin commands work without a separate `cupboard login`. A refusal is an
 * answer, not a failure: the gate may name a different principal by the time
 * the claim lands.
 */
async function claimAdmin(
	ui: DeployUi,
	client: OnboardClient,
	url: string,
	proof: { readonly idToken: string; readonly claimSecret: string | undefined },
	cacheToken: (token: string, target: string) => Promise<void>
): Promise<ClaimResult> {
	let claim:
		| {
				readonly claimed: boolean;
				readonly subject: string;
				readonly token: string;
		  }
		| undefined;

	try {
		claim = await ui.reporter().phase('Setting up admin access', async () => {
			const signup = await client.signup({
				subject_token: proof.idToken,
				...(proof.claimSecret === undefined
					? {}
					: { claim_secret: proof.claimSecret })
			});
			const exchanged = await client.tokenExchange(
				proof.idToken,
				subjectTokenTypeIdToken
			);

			await cacheToken(exchanged.access_token, url);

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
				detail: `${error.method} ${error.path} answered ${httpDetail(error)}`
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
 * Prompts for a slug (no default: the name is the operator's to choose) and
 * creates the tenant under it. The create call is the arbiter of ownership:
 * a slug can be claimed between the prompt and the request landing, and the
 * conflict answer re-prompts. Re-creating an identical tenant is idempotent
 * on the server, so a re-run converges by entering the same slug.
 */
async function createFirstTenant(
	ui: DeployUi,
	client: OnboardClient,
	url: string,
	token: string,
	owner: OwnerBinding
): Promise<ParsedTenantSummary | undefined> {
	for (;;) {
		const slug = await ui.prefixedText({
			message: 'Choose a slug for the first cache',
			prefix: `${url}/t/`,
			problem: slugProblem
		});

		if (slug === undefined) {
			return undefined;
		}

		try {
			return await ui.reporter().phase(`Creating ${slug}`, () =>
				client.createTenant(token, {
					id: slug,
					readMode: 'public',
					ownerIssuer: owner.issuer,
					ownerSubject: owner.subject,
					ownerAudience: owner.audience
				})
			);
		} catch (error) {
			if (
				error instanceof CupboardHttpError &&
				error.status === conflictStatusCode
			) {
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
	sleep: (ms: number) => Promise<void>,
	probe: () => Promise<Probe<T>>
): Promise<
	| { readonly kind: 'ready'; readonly value: T }
	| { readonly kind: 'gave-up'; readonly lastProbe: string }
> {
	let ready: { value: T } | undefined;
	let lastProbe = 'no answer';

	await ui.reporter().phase(label, async (context) => {
		for (let attempt = 1; attempt <= attempts; attempt += 1) {
			const probed = await attemptProbe(probe);

			if (probed.kind === 'ready') {
				ready = { value: probed.value };
				return;
			}

			lastProbe = probed.detail;

			if (attempt < attempts) {
				context.fact('attempt', attempt);
				context.fact('last answer', probed.detail);
				await sleep(attemptDelayMs);
			}
		}
	});

	return ready === undefined
		? { kind: 'gave-up', lastProbe }
		: { kind: 'ready', value: ready.value };
}

async function attemptProbe<T>(
	probe: () => Promise<Probe<T>>
): Promise<Probe<T>> {
	try {
		return await probe();
	} catch (error) {
		if (error instanceof CupboardHttpError) {
			if (retryableStatus(error.status)) {
				return { kind: 'retry', detail: httpDetail(error) };
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

function retryableStatus(status: number): boolean {
	return status === 404 || status === 408 || status === 429 || status >= 500;
}

// The status with the server's own words, compacted to one short line so it
// fits a spinner fact or a closing warning.
function httpDetail(error: CupboardHttpError): string {
	const body = error.body.replaceAll(/\s+/g, ' ').trim();
	const compact = body.length <= 120 ? body : `${body.slice(0, 120)}…`;

	return compact === ''
		? `HTTP ${String(error.status)}`
		: `HTTP ${String(error.status)}: ${compact}`;
}
