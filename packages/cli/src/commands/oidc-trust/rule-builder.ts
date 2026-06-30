import { WIRE_DEFAULT_CACHE } from '@cupboard/nix-store/scalars';
import { captureGroups, quotePatternLiteral } from '@cupboard/protocol/capture';
import {
	type PermittedGrant,
	permittedGrantSchema,
	type Substitution
} from '@cupboard/protocol/grants';
import {
	type ClaimMatch,
	type OidcTrustAddBody,
	oidcTrustAddBodySchema
} from '@cupboard/protocol/oidc';

import { InvalidClaimError } from '../../errors.ts';

/**
 * The match for a `job_workflow_ref` claim value of the form
 * `owner/repo/path@ref`. When the value carries an `@ref` it is matched exactly;
 * without one it becomes a pattern matching that workflow file at any ref, which
 * is the shape a reusable workflow needs since its ref is the file's own, not
 * the branch that triggered the run.
 */
export function jobWorkflowReferenceClaim(value: string): ClaimMatch {
	if (value.includes('@')) {
		return value;
	}

	return { pattern: `^${quotePatternLiteral(value)}@.+$` };
}

// The cache operations each `--allow` shorthand expands to. `push` and `attest`
// are the upload and attestation conversations; `root` is a retention-root write.
const allowExpansions = {
	push: ['upload:negotiate', 'upload:status', 'upload:commit'],
	attest: ['attestation:negotiate', 'attestation:attach'],
	root: ['root:set']
} as const;

export type AllowShorthand = keyof typeof allowExpansions;

// A named capture source baked into the CLI for a provider, so a common rule
// needs no hand-written pattern. `github-pr` reads a GitHub Actions `ref` of the
// form `refs/pull/<n>/merge` and binds the pull-request number to `{pr}`.
const templateSources = {
	'github-pr': {
		claim: 'ref',
		pattern: '^refs/pull/(?<pr>[0-9]+)/merge$'
	}
} as const;

export type TemplateSource = keyof typeof templateSources;

export class UnknownAllowError extends Error {
	constructor(public readonly value: string) {
		super(
			`Unknown --allow value '${value}'. Expected one of: ${Object.keys(allowExpansions).join(', ')}.`
		);
		this.name = 'UnknownAllowError';
	}
}

export class UnknownTemplateSourceError extends Error {
	constructor(public readonly value: string) {
		super(
			`Unknown --template-source '${value}'. Expected one of: ${Object.keys(templateSources).join(', ')}.`
		);
		this.name = 'UnknownTemplateSourceError';
	}
}

export class InvalidCaptureSpecError extends Error {
	constructor(public readonly spec: string) {
		super(`--capture must be <claim>=<pattern>, got '${spec}'.`);
		this.name = 'InvalidCaptureSpecError';
	}
}

export class DuplicateCaptureVariableError extends Error {
	constructor(public readonly variable: string) {
		super(
			`Template variable '${variable}' is defined by more than one capture.`
		);
		this.name = 'DuplicateCaptureVariableError';
	}
}

export function expandAllow(values: readonly string[]): {
	cacheActions: string[];
	rootActions: string[];
} {
	const cacheActions = new Set<string>();
	const rootActions = new Set<string>();

	for (const value of values) {
		if (!Object.hasOwn(allowExpansions, value)) {
			throw new UnknownAllowError(value);
		}

		const actions = allowExpansions[value as AllowShorthand];
		for (const action of actions) {
			(value === 'root' ? rootActions : cacheActions).add(action);
		}
	}

	return { cacheActions: [...cacheActions], rootActions: [...rootActions] };
}

// Each named group in a `<claim>=<pattern>` capture becomes a template variable
// bound to that claim. `captureGroups` rejects an unanchored pattern or one with
// no named group, so a malformed capture fails here.
export function parseCapture(spec: string): Record<string, Substitution> {
	const separator = spec.indexOf('=');

	if (separator <= 0) {
		throw new InvalidCaptureSpecError(spec);
	}

	const claim = spec.slice(0, separator);
	const pattern = spec.slice(separator + 1);
	const substitutions: Record<string, Substitution> = {};

	for (const group of captureGroups(pattern)) {
		substitutions[group] = { claim, capture: { pattern, group } };
	}

	return substitutions;
}

// Merge the substitutions from `--template-source` and every `--capture`,
// rejecting a variable defined more than once so a rule never depends on which
// flag was read last.
export function collectSubstitutions(options: {
	readonly templateSource?: string;
	readonly captures: readonly string[];
}): Record<string, Substitution> {
	const merged: Record<string, Substitution> = {};

	const add = (substitutions: Record<string, Substitution>): void => {
		for (const [variable, substitution] of Object.entries(substitutions)) {
			if (Object.hasOwn(merged, variable)) {
				throw new DuplicateCaptureVariableError(variable);
			}

			merged[variable] = substitution;
		}
	};

	if (options.templateSource !== undefined) {
		if (!Object.hasOwn(templateSources, options.templateSource)) {
			throw new UnknownTemplateSourceError(options.templateSource);
		}

		const source = templateSources[options.templateSource as TemplateSource];

		add(parseCapture(`${source.claim}=${source.pattern}`));
	}

	for (const capture of options.captures) {
		add(parseCapture(capture));
	}

	return merged;
}

const placeholderPattern = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

// The substitutions a template actually references, so a binding carries no
// unused entries.
function referencedSubstitutions(
	template: string,
	substitutions: Record<string, Substitution>
): Record<string, Substitution> {
	const referenced: Record<string, Substitution> = {};

	for (const match of template.matchAll(placeholderPattern)) {
		const variable = match[1];
		const substitution =
			variable === undefined ? undefined : substitutions[variable];

		if (variable !== undefined && substitution !== undefined) {
			referenced[variable] = substitution;
		}
	}

	return referenced;
}

export interface CacheGrantOptions {
	readonly cache?: string;
	readonly cacheTemplate?: string;
	readonly allow: readonly string[];
	readonly root?: string;
	readonly rootTemplate?: string;
	readonly substitutions?: Record<string, Substitution>;
}

// Build the single cache grant a `--allow`/`--cache`/`--root` set describes: an
// exact or templated cache binding, and a root binding that is the cache itself
// (`--root same-as-cache`), an exact name, or its own template.
export function buildCacheGrant(options: CacheGrantOptions): PermittedGrant {
	const { cacheActions, rootActions } = expandAllow(options.allow);
	const substitutions = options.substitutions ?? {};
	const hasRoot = rootActions.length > 0 || options.root !== undefined;

	return permittedGrantSchema.parse({
		type: 'cupboard_cache',
		actions: [...cacheActions, ...rootActions],
		resources: {
			cache: cacheBinding(options, substitutions),
			...(hasRoot && { root: rootBinding(options, substitutions) })
		}
	});
}

function cacheBinding(
	options: CacheGrantOptions,
	substitutions: Record<string, Substitution>
): Record<string, unknown> {
	if (options.cacheTemplate !== undefined) {
		return {
			equalsTemplate: options.cacheTemplate,
			substitutions: referencedSubstitutions(
				options.cacheTemplate,
				substitutions
			),
			validate: 'cacheName'
		};
	}

	if (options.cache !== undefined) {
		return { exact: options.cache, validate: 'cacheName' };
	}

	// Omitting the cache scopes the grant to the tenant's default cache. The
	// wire alias for it is never something a user has to type.
	return { exact: WIRE_DEFAULT_CACHE, validate: 'cacheName' };
}

function rootBinding(
	options: CacheGrantOptions,
	substitutions: Record<string, Substitution>
): Record<string, unknown> {
	if (options.rootTemplate !== undefined) {
		return {
			equalsTemplate: options.rootTemplate,
			substitutions: referencedSubstitutions(
				options.rootTemplate,
				substitutions
			),
			validate: 'rootName'
		};
	}

	if (options.root === undefined || options.root === 'same-as-cache') {
		return { validate: 'rootName', equalsResource: 'cache' };
	}

	return { validate: 'rootName', exact: options.root };
}

export interface AddBodyOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly claims: Record<string, ClaimMatch>;
	readonly permittedGrants: readonly PermittedGrant[];
	readonly display?: OidcTrustAddBody['display'];
}

// Validate the assembled rule against the contract schema, so the CLI fails on a
// malformed grant before the request leaves the machine.
export function buildAddBody(options: AddBodyOptions): OidcTrustAddBody {
	const parsed = oidcTrustAddBodySchema.safeParse({
		issuer: options.issuer,
		audience: options.audience,
		claims: options.claims,
		permittedGrants: options.permittedGrants,
		...(options.display !== undefined && { display: options.display })
	});

	if (!parsed.success) {
		throw new InvalidClaimError(parsed.error.message);
	}

	return parsed.data;
}
