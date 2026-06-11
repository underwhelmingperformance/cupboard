import { cloudflareOauthClientId } from './cloudflare-oauth.ts';
import type { DeploymentConfig } from './config.ts';

/** The Cloudflare dashboard's OIDC issuer, used for deployer-bound owners. */
export const cloudflareDashIssuer = 'https://dash.cloudflare.com';

/**
 * The OIDC triple the control plane's signup gate pins: who may claim global
 * admin of the deployment, and (by default) who owns the tenants it creates.
 */
export interface OwnerBinding {
	readonly issuer: string;
	readonly subject: string;
	readonly audience: string;
}

/**
 * Who will administer the deployment: a bound identity (and where it came
 * from), or nobody, which leaves the signup gate closed (no admin claim, no
 * tenants, until a redeploy configures one).
 */
export type OwnerChoice =
	| {
			readonly kind: 'owner';
			readonly owner: OwnerBinding;
			readonly origin: 'deployer' | 'manual' | 'config';
	  }
	| { readonly kind: 'none' };

/**
 * The binding for the person deploying: their Cloudflare identity, as carried
 * in the id_token cupboard's OAuth client receives. The audience is the
 * client id, which is also what a flagless `cupboard login` presents.
 */
export function deployerOwner(subject: string): OwnerBinding {
	return {
		issuer: cloudflareDashIssuer,
		subject,
		audience: cloudflareOauthClientId
	};
}

/** The admin gate configured in the wrangler vars, when fully set. */
export function configuredOwner(
	variables: Readonly<Record<string, string>>
): OwnerBinding | undefined {
	const issuer = variables.CUPBOARD_SIGNUP_ISSUER;
	const subject = variables.CUPBOARD_SIGNUP_SUBJECT;
	const audience = variables.CUPBOARD_SIGNUP_AUDIENCE;

	if (!issuer || !subject || !audience) {
		return undefined;
	}

	return { issuer, subject, audience };
}

/**
 * The admin the plan starts from: a gate already configured in the wrangler
 * vars wins, then the deployer when their identity is known, otherwise nobody.
 */
export function defaultOwnerChoice(
	config: DeploymentConfig,
	deployerSubject?: string
): OwnerChoice {
	const configured = configuredOwner(config.control.vars);

	if (configured !== undefined) {
		return { kind: 'owner', owner: configured, origin: 'config' };
	}

	if (deployerSubject !== undefined) {
		return {
			kind: 'owner',
			owner: deployerOwner(deployerSubject),
			origin: 'deployer'
		};
	}

	return { kind: 'none' };
}

const originLabels = {
	deployer: 'you, the deployer',
	manual: 'manual',
	config: 'from wrangler config'
} as const;

/** A one-line description of the choice, for the plan row and menu hint. */
export function ownerHint(choice: OwnerChoice): string {
	if (choice.kind === 'none') {
		return '(none: nobody can claim admin)';
	}

	const { owner, origin } = choice;
	const host = new URL(owner.issuer).hostname;

	return `${host} · ${owner.subject} (${originLabels[origin]})`;
}

/** Why `value` cannot be an owner issuer, or undefined when it can. */
export function ownerIssuerProblem(value: string): string | undefined {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		return 'the issuer must be a URL';
	}

	if (url.protocol !== 'https:') {
		return 'the issuer must use https';
	}

	if (url.search !== '' || url.hash !== '' || url.username !== '') {
		return 'the issuer must be a bare https URL, without query or fragment';
	}

	return undefined;
}

/** Why `value` cannot be an owner subject or audience. */
export function ownerFieldProblem(value: string): string | undefined {
	if (value.trim() === '') {
		return 'a value is required';
	}

	if (/\s/.test(value)) {
		return 'the value must not contain whitespace';
	}

	return undefined;
}
