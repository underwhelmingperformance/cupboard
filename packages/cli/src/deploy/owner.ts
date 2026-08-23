import { cloudflareOauthClientId } from './cloudflare-oauth.ts';
import type { DeploymentConfig } from './config.ts';

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
 * Builds an owner binding from the Cloudflare ID token used by deploy. The
 * OAuth client ID is both the token audience and the audience used by a
 * flagless `cupboard login`.
 */
export function deployerOwner(subject: string): OwnerBinding {
	return {
		issuer: cloudflareDashIssuer,
		subject,
		audience: cloudflareOauthClientId
	};
}

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

export function ownerHint(choice: OwnerChoice): string {
	if (choice.kind === 'none') {
		return '(none: nobody can claim admin)';
	}

	const { owner, origin } = choice;
	const issuerUrl = new URL(owner.issuer);
	const host = issuerUrl.hostname;

	return `${host} · ${owner.subject} (${originLabels[origin]})`;
}

export type OwnerIssuerProblem = 'not-url' | 'not-https' | 'not-bare-url';

export function ownerIssuerProblem(
	value: string
): OwnerIssuerProblem | undefined {
	let url: URL;

	try {
		url = new URL(value);
	} catch {
		return 'not-url';
	}

	if (url.protocol !== 'https:') {
		return 'not-https';
	}

	if (url.search !== '' || url.hash !== '' || url.username !== '') {
		return 'not-bare-url';
	}

	return undefined;
}

export function ownerIssuerProblemMessage(problem: OwnerIssuerProblem): string {
	switch (problem) {
		case 'not-bare-url': {
			return 'the issuer must be a bare https URL, without query or fragment';
		}
		case 'not-https': {
			return 'the issuer must use https';
		}
		case 'not-url': {
			return 'the issuer must be a URL';
		}
	}
}

export function ownerIssuerProblemText(value: string): string | undefined {
	const problem = ownerIssuerProblem(value);

	return problem === undefined ? undefined : ownerIssuerProblemMessage(problem);
}

export type OwnerFieldProblem = 'empty' | 'whitespace';

export function ownerFieldProblem(
	value: string
): OwnerFieldProblem | undefined {
	if (value.trim() === '') {
		return 'empty';
	}

	if (/\s/.test(value)) {
		return 'whitespace';
	}

	return undefined;
}

export function ownerFieldProblemMessage(problem: OwnerFieldProblem): string {
	switch (problem) {
		case 'empty': {
			return 'a value is required';
		}
		case 'whitespace': {
			return 'the value must not contain whitespace';
		}
	}
}

export function ownerFieldProblemText(value: string): string | undefined {
	const problem = ownerFieldProblem(value);

	return problem === undefined ? undefined : ownerFieldProblemMessage(problem);
}
