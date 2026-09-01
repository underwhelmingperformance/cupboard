import { captureGroups, quotePatternLiteral } from '@cupboard/protocol/capture';
import {
	type CacheOperation,
	type PermittedGrant,
	permittedGrantSchema,
	type Substitution
} from '@cupboard/protocol/grants';
import type { ManagedPolicyId } from '@cupboard/protocol/managed-caches';
import {
	type ClaimMatch,
	type OidcTrustAddBodyInput,
	oidcTrustAddBodySchema
} from '@cupboard/protocol/oidc';

import { CliUsageError, InvalidClaimError } from '../../errors.ts';
import {
	parseWorkflowReference,
	workflowReferenceClaim
} from '../github/convention.ts';

/**
 * Builds a matcher for a `job_workflow_ref` value. A value with `@ref` matches
 * exactly, except that a `refs/tags/<glob>` ref becomes a pattern for matching
 * tags. A value without `@ref` accepts the workflow file at any ref. This last
 * form supports reusable workflows because the claim contains the called
 * workflow's ref, not the ref that triggered the caller.
 */
export function jobWorkflowReferenceClaim(value: string): ClaimMatch {
	if (value.includes('*')) {
		return workflowReferenceClaim(parseWorkflowReference(value));
	}

	if (value.includes('@')) {
		return value;
	}

	return { pattern: `^${quotePatternLiteral(value)}@.+$` };
}

// Keep `upload:confirm` in `push`: cache-aware publication refreshes the
// retention of paths that it can already substitute without uploading them.
// Keep `root:list` in `root`: publication reads the reconciled target list
// before replacing it. `attach` remains separate because attachment requires a
// root binding, while an ordinary push does not.
const allowExpansions = {
	push: [
		'upload:negotiate',
		'upload:status',
		'upload:commit',
		'upload:confirm'
	],
	attest: ['attestation:negotiate', 'attestation:attach'],
	root: ['root:set', 'root:list'],
	attach: ['root:attach']
} as const;

export type AllowShorthand = keyof typeof allowExpansions;

// Every shorthand in this set requires a root binding. Adding another
// root-scoped shorthand to `allowExpansions` also requires adding it here.
const rootAllowShorthands: ReadonlySet<AllowShorthand> = new Set([
	'root',
	'attach'
]);

function isAllowShorthand(value: string): value is AllowShorthand {
	return Object.hasOwn(allowExpansions, value);
}

const templateSources = {
	'github-pr': {
		claim: 'ref',
		pattern: '^refs/pull/(?<pr>[0-9]+)/merge$'
	},
	// The capture excludes characters that would make a `{tag}` substitution
	// invalid in a cache or root name. Tags outside this subset do not match the
	// trust rule.
	'github-tag': {
		claim: 'ref',
		pattern: '^refs/tags/(?<tag>[a-z0-9][a-z0-9._-]*)$'
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

export class RootBindingRequiredError extends CliUsageError {
	constructor() {
		super(
			'The selected operations can manage roots. Specify which root they may manage with --root or --root-template.'
		);
		this.name = 'RootBindingRequiredError';
	}
}

export function expandAllow(values: readonly string[]): {
	cacheActions: CacheOperation[];
	rootActions: CacheOperation[];
} {
	const cacheActions = new Set<CacheOperation>();
	const rootActions = new Set<CacheOperation>();

	for (const value of values) {
		if (!isAllowShorthand(value)) {
			throw new UnknownAllowError(value);
		}

		const bucket = rootAllowShorthands.has(value) ? rootActions : cacheActions;
		const actions = allowExpansions[value];

		for (const action of actions) {
			bucket.add(action);
		}
	}

	return { cacheActions: [...cacheActions], rootActions: [...rootActions] };
}

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

// Reject duplicate variables instead of letting flag order decide which
// capture supplies a template value.
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
	readonly managedPolicy?: ManagedPolicyId;
}

export function buildCacheGrant(options: CacheGrantOptions): PermittedGrant {
	const { cacheActions, rootActions } = expandAllow(options.allow);

	if (
		rootActions.length > 0 &&
		options.root === undefined &&
		options.rootTemplate === undefined
	) {
		throw new RootBindingRequiredError();
	}

	const actions =
		options.managedPolicy === undefined
			? [...cacheActions, ...rootActions]
			: ['cache:provision', ...cacheActions, ...rootActions];
	const substitutions = options.substitutions ?? {};
	const hasRoot =
		rootActions.length > 0 ||
		options.root !== undefined ||
		options.rootTemplate !== undefined;

	return permittedGrantSchema.parse({
		type: 'cupboard_cache',
		actions,
		resources: {
			cache: cacheBinding(options, substitutions),
			...(hasRoot && { root: rootBinding(options, substitutions) }),
			...(options.managedPolicy !== undefined && {
				managedPolicy: options.managedPolicy
			})
		}
	});
}

function cacheBinding(
	options: CacheGrantOptions,
	substitutions: Record<string, Substitution>
): Record<string, unknown> {
	if (options.cacheTemplate !== undefined) {
		return {
			kind: 'named',
			equalsTemplate: options.cacheTemplate,
			substitutions: referencedSubstitutions(
				options.cacheTemplate,
				substitutions
			),
			validate: 'cacheName'
		};
	}

	if (options.cache !== undefined) {
		return {
			kind: 'named',
			exact: options.cache,
			validate: 'cacheName'
		};
	}

	return { kind: 'default' };
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

	if (options.root === undefined) {
		throw new RootBindingRequiredError();
	}

	return { validate: 'rootName', exact: options.root };
}

export interface AddBodyOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly claims: Record<string, ClaimMatch>;
	readonly permittedGrants: readonly PermittedGrant[];
	readonly display?: OidcTrustAddBodyInput['display'];
}

export function buildAddBody(options: AddBodyOptions): OidcTrustAddBodyInput {
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
