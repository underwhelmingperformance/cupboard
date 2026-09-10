import {
	type CacheAccessMode,
	type CacheName,
	cacheNameSchema,
	type CacheScope,
	cacheScopeSchema,
	isSameCacheScope,
	type RootName,
	rootNameSchema,
	type TenantId,
	tenantIdSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

// Tokens encode grants in the RFC 9396 `authorization_details` claim.
// `isCoveredByToken` checks the route's required operation against the concrete
// request resource. Stored trust rules use templates and captures that resolve
// to concrete resources when the server issues a token.

// Cache-scoped tenant operations. `gc:run` and `stats:read` also appear as
// domain operations: the per-cache form carries a cache, the deployment-wide
// form carries none, and the procedure's declared resource picks which.
export const cacheOperationSchema = z.enum([
	'upload:negotiate',
	'upload:preview',
	'upload:status',
	'upload:commit',
	'upload:confirm',
	'attestation:negotiate',
	'attestation:attach',
	'root:set',
	'root:attach',
	'root:list',
	'root:remove',
	'cache:read',
	'cache:create',
	'cache:update',
	'cache:delete',
	'narinfo:delete',
	'gc:run',
	'stats:read'
]);
export type CacheOperation = z.infer<typeof cacheOperationSchema>;
export const cacheOperations: readonly CacheOperation[] =
	cacheOperationSchema.options;

// Tenant-domain operations use authority over the tenant established by the
// issuer. They have no separate resource selector.
const domainOperationSchema = z.enum([
	'cache:list',
	'stats:read',
	'check:run',
	'verification:run',
	'gc:run',
	'signing-key:list',
	'signing-key:rotate',
	'signing-key:retire',
	'auth-key:list',
	'auth-key:rotate',
	'auth-key:retire',
	'oidc-trust:list',
	'oidc-trust:read',
	'oidc-trust:add',
	'oidc-trust:remove',
	'policy:list',
	'policy:remove',
	'reuse-view:list',
	'reuse-view:set',
	'reuse-view:remove'
]);
export const domainOperations = domainOperationSchema.options;

// These control operations require an exact tenant slug as their resource.
const tenantOperationSchema = z.enum([
	'tenant:create',
	'tenant:suspend',
	'tenant:resume',
	'tenant:remove',
	'tenant:rotate-read-credential',
	'tenant:clear-read-credential',
	'tenant:rotate-cache-read-credential',
	'tenant:clear-cache-read-credential'
]);
export const tenantOperations = tenantOperationSchema.options;

// These control operations do not select a resource.
const controlOperationSchema = z.enum([
	'control:check',
	'instance:read',
	'instance:initialise',
	'control-key:list',
	'control-key:rotate',
	'control-key:retire',
	'tenant:list',
	'membership:rebuild',
	'deployment:read',
	'local-step:read',
	'local-step:wake',
	'control-oidc-trust:list',
	'control-oidc-trust:read',
	'control-oidc-trust:add',
	'control-oidc-trust:remove'
]);
export const controlOperations = controlOperationSchema.options;

// `gc:run` and `stats:read` occur in two grant types but appear once in this
// combined schema.
export const operationSchema = z.enum([
	'upload:negotiate',
	'upload:preview',
	'upload:status',
	'upload:commit',
	'upload:confirm',
	'attestation:negotiate',
	'attestation:attach',
	'root:set',
	'root:attach',
	'root:list',
	'root:remove',
	'cache:read',
	'cache:create',
	'cache:update',
	'cache:delete',
	'cache:list',
	'narinfo:delete',
	'gc:run',
	'stats:read',
	'check:run',
	'verification:run',
	'signing-key:list',
	'signing-key:rotate',
	'signing-key:retire',
	'auth-key:list',
	'auth-key:rotate',
	'auth-key:retire',
	'oidc-trust:list',
	'oidc-trust:read',
	'oidc-trust:add',
	'oidc-trust:remove',
	'policy:list',
	'policy:remove',
	'reuse-view:list',
	'reuse-view:set',
	'reuse-view:remove',
	'control:check',
	'instance:read',
	'instance:initialise',
	'control-key:list',
	'control-key:rotate',
	'control-key:retire',
	'tenant:list',
	'tenant:create',
	'tenant:suspend',
	'tenant:resume',
	'tenant:remove',
	'tenant:rotate-read-credential',
	'tenant:clear-read-credential',
	'tenant:rotate-cache-read-credential',
	'tenant:clear-cache-read-credential',
	'membership:rebuild',
	'deployment:read',
	'local-step:read',
	'local-step:wake',
	'control-oidc-trust:list',
	'control-oidc-trust:read',
	'control-oidc-trust:add',
	'control-oidc-trust:remove'
]);
export type Operation = z.infer<typeof operationSchema>;

/**
Whether the operation uses the grant's root selector.
*/
export function isRootOperation(operation: Operation): boolean {
	return operation.startsWith('root:');
}

export interface ResourceRequest {
	readonly cache?: CacheScope;
	readonly root?: RootName;
	readonly tenant?: TenantId;
}

// Issued grants contain only concrete resources. A cache scope identifies one
// cache and a tenant selector identifies one tenant; a root selector is an
// exact name or a trailing-slash prefix. The wildcard is the only non-concrete
// grant and covers its whole domain.
//
// A cache grant identifies the cache by scope, independent of its access. The
// grant still applies if the cache changes between public and private reads.

const grantTypeSchema = z.enum([
	'cupboard_cache',
	'cupboard_domain',
	'cupboard_tenant',
	'cupboard_control',
	'cupboard_wildcard'
]);
export const grantTypes = grantTypeSchema.options;

const cacheActionsSchema = z.array(cacheOperationSchema).min(1);
const domainActionsSchema = z.array(domainOperationSchema).min(1);
const tenantActionsSchema = z.array(tenantOperationSchema).min(1);
const controlActionsSchema = z.array(controlOperationSchema).min(1);

export const authorizationDetailSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('cupboard_cache'),
		actions: cacheActionsSchema,
		cache: cacheScopeSchema,
		root: rootNameSchema.optional()
	}),
	z.strictObject({
		type: z.literal('cupboard_domain'),
		actions: domainActionsSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_tenant'),
		actions: tenantActionsSchema,
		tenant: tenantIdSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_control'),
		actions: controlActionsSchema
	}),
	z.strictObject({ type: z.literal('cupboard_wildcard') })
]);
export type AuthorizationDetail = z.infer<typeof authorizationDetailSchema>;

export const authorizationDetailsSchema = z.array(authorizationDetailSchema);
export type AuthorizationDetails = z.infer<typeof authorizationDetailsSchema>;

function isRootWithin(requested: string, granted: string): boolean {
	return granted.endsWith('/')
		? requested.startsWith(granted)
		: requested === granted;
}

// At issuance, a rule that permits `upload:negotiate` may also issue
// `upload:preview` because preview performs only the read-only classification
// step.
const impliedAtIssuance: Partial<Record<Operation, Operation>> = {
	'upload:preview': 'upload:negotiate'
};

// A presented negotiate grant also authorises preview during route checks and
// attenuation.
const impliedByPresentedAuthority: Partial<Record<Operation, Operation>> = {
	'upload:preview': 'upload:negotiate'
};
const cacheOperationSet: ReadonlySet<Operation> = new Set(cacheOperations);

function isOperationImplied(
	actions: readonly Operation[],
	operation: Operation,
	impliedBy: Partial<Record<Operation, Operation>>
): boolean {
	if (actions.includes(operation)) {
		return true;
	}

	if (
		operation === 'cache:read' &&
		actions.some((action) => cacheOperationSet.has(action))
	) {
		return true;
	}

	const broaderOperation = impliedBy[operation];

	return broaderOperation !== undefined && actions.includes(broaderOperation);
}

/**
 * Checks whether a stored trust-rule grant permits `operation` when the server
 * issues or refreshes a token. The operation can be listed directly or implied
 * by {@link impliedAtIssuance}.
 */
export function isOperationPermittedAtIssuance(
	actions: readonly Operation[],
	operation: Operation
): boolean {
	return isOperationImplied(actions, operation, impliedAtIssuance);
}

/**
 * Checks whether a presented token authorises `operation`. Route checks and
 * attenuation accept either a listed operation or one implied by
 * {@link impliedByPresentedAuthority}.
 */
export function isOperationSatisfiedByPresentedActions(
	actions: readonly Operation[],
	operation: Operation
): boolean {
	return isOperationImplied(actions, operation, impliedByPresentedAuthority);
}

function isCoveredByGrant(
	grant: AuthorizationDetail,
	operation: Operation,
	resource: ResourceRequest
): boolean {
	if (grant.type === 'cupboard_wildcard') {
		return true;
	}

	const actions: readonly Operation[] = grant.actions;

	if (!isOperationSatisfiedByPresentedActions(actions, operation)) {
		return false;
	}

	switch (grant.type) {
		case 'cupboard_cache': {
			if (
				resource.cache === undefined ||
				!isSameCacheScope(resource.cache, grant.cache)
			) {
				return false;
			}

			if (!isRootOperation(operation)) {
				return true;
			}

			if (resource.root === undefined) {
				return grant.root === undefined;
			}

			return (
				grant.root !== undefined && isRootWithin(resource.root, grant.root)
			);
		}
		case 'cupboard_tenant': {
			return resource.tenant !== undefined && resource.tenant === grant.tenant;
		}
		case 'cupboard_domain':
		case 'cupboard_control': {
			// Resource-free: covers only the deployment-wide invocation, never a
			// cache- or tenant-scoped one.
			return resource.cache === undefined && resource.tenant === undefined;
		}
	}
}

/**
 * Checks whether any presented grant authorises `operation` on `resource`.
 * The server uses this after token verification, and the CLI uses the same
 * decision for its preflight check.
 */
export function isCoveredByToken(
	grants: readonly AuthorizationDetail[],
	operation: Operation,
	resource: ResourceRequest
): boolean {
	return grants.some((grant) => isCoveredByGrant(grant, operation, resource));
}

function detailResource(detail: AuthorizationDetail): ResourceRequest {
	switch (detail.type) {
		case 'cupboard_cache': {
			return { cache: detail.cache, root: detail.root };
		}
		case 'cupboard_tenant': {
			return { tenant: detail.tenant };
		}
		default: {
			return {};
		}
	}
}

/**
 * Checks whether `grants` authorises every operation in `detail` for its
 * selected resource. Attenuation uses this to prevent a new token from exceeding
 * the presenter's authority. Only a wildcard grant covers a requested wildcard.
 */
export function isAuthorizationDetailCovered(
	grants: readonly AuthorizationDetail[],
	detail: AuthorizationDetail
): boolean {
	if (detail.type === 'cupboard_wildcard') {
		return grants.some((grant) => grant.type === 'cupboard_wildcard');
	}

	const resource = detailResource(detail);
	const actions: readonly Operation[] = detail.actions;

	return actions.every((operation) =>
		isCoveredByToken(grants, operation, resource)
	);
}

export const templateMaxLength = 256;
export const capturePatternMaxLength = 512;
export const captureGroupMaxLength = 64;
export const claimNameMaxLength = 128;
export const maxSubstitutionsPerBinding = 8;
export const displayFieldMaxLength = 256;

const templateVariablePattern = /^[A-Za-z_][A-Za-z0-9_]*$/u;
const templatePlaceholderPattern = /\{([A-Za-z_][A-Za-z0-9_]*)\}/gu;

export const templateSchema = z.string().min(1).max(templateMaxLength);

export function templateVariables(template: string): string[] {
	const variables: string[] = [];

	for (const match of template.matchAll(templatePlaceholderPattern)) {
		const variable = match[1];

		if (variable !== undefined) {
			variables.push(variable);
		}
	}

	return variables;
}

const captureSchema = z.strictObject({
	pattern: z.string().min(1).max(capturePatternMaxLength),
	group: z.string().min(1).max(captureGroupMaxLength)
});

export const substitutionSchema = z
	.strictObject({
		claim: z.string().min(1).max(claimNameMaxLength),
		capture: captureSchema.optional(),
		slug: z.literal(true).optional()
	})
	.refine((value) => value.capture === undefined || value.slug === undefined, {
		message: 'Set at most one of capture and slug'
	});
export type Substitution = z.infer<typeof substitutionSchema>;

const substitutionMapSchema = z
	.record(z.string().regex(templateVariablePattern), substitutionSchema)
	.refine((map) => Object.keys(map).length <= maxSubstitutionsPerBinding, {
		message: `A binding may define at most ${String(maxSubstitutionsPerBinding)} substitutions`
	});

const bindingShape = {
	equalsTemplate: templateSchema.optional(),
	exact: z.string().min(1).optional(),
	substitutions: substitutionMapSchema.optional()
};

function refineBinding(
	value: {
		readonly equalsTemplate?: string;
		readonly exact?: string;
		readonly substitutions?: Record<string, Substitution>;
	},
	ctx: z.RefinementCtx
): void {
	const choices = [
		value.equalsTemplate !== undefined,
		value.exact !== undefined
	].filter(Boolean).length;

	if (choices !== 1) {
		ctx.addIssue({
			code: 'custom',
			message: 'Set exactly one of equalsTemplate and exact'
		});
	}

	if (value.equalsTemplate === undefined) {
		return;
	}

	const provided = new Set(Object.keys(value.substitutions ?? {}));

	for (const variable of templateVariables(value.equalsTemplate)) {
		if (!provided.has(variable)) {
			ctx.addIssue({
				code: 'custom',
				message: `Define a substitution for template variable ${variable}`
			});
		}
	}
}

export const cacheBindingSchema = z.discriminatedUnion('kind', [
	z.strictObject({ kind: z.literal('default') }),
	z
		.strictObject({
			kind: z.literal('named'),
			...bindingShape,
			validate: z.literal('cacheName')
		})
		.superRefine((value, ctx) => {
			refineBinding(value, ctx);
		})
]);
export const rootBindingSchema = z
	.strictObject({
		...bindingShape,
		validate: z.literal('rootName')
	})
	.superRefine((value, ctx) => {
		refineBinding(value, ctx);
	});
export const tenantBindingSchema = z
	.strictObject({ ...bindingShape, validate: z.literal('tenant') })
	.superRefine((value, ctx) => {
		refineBinding(value, ctx);
	});

export const oidcTrustDisplaySchema = z.strictObject({
	provider: z.string().max(displayFieldMaxLength).optional(),
	preset: z.string().max(displayFieldMaxLength).optional(),
	repository: z.string().max(displayFieldMaxLength).optional()
});
export type OidcTrustDisplay = z.infer<typeof oidcTrustDisplaySchema>;

const cacheResourcesSchema = z.strictObject({
	cache: cacheBindingSchema,
	root: rootBindingSchema.optional()
});
const tenantResourcesSchema = z.strictObject({ tenant: tenantBindingSchema });

export const permittedGrantSchema = z.discriminatedUnion('type', [
	z.strictObject({
		type: z.literal('cupboard_cache'),
		actions: cacheActionsSchema,
		resources: cacheResourcesSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_domain'),
		actions: domainActionsSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_tenant'),
		actions: tenantActionsSchema,
		resources: tenantResourcesSchema
	}),
	z.strictObject({
		type: z.literal('cupboard_control'),
		actions: controlActionsSchema
	}),
	z.strictObject({ type: z.literal('cupboard_wildcard') })
]);
export type PermittedGrant = z.infer<typeof permittedGrantSchema>;

const knownOperations: ReadonlySet<string> = new Set(operationSchema.options);

const grantWithActionsSchema = z.looseObject({ actions: z.array(z.unknown()) });

// Stored rules can contain operations removed by a later release. Remove unknown
// operations before strict validation. Remove a non-wildcard grant if no
// recognised operation remains. Preserve wildcard grants because they have no
// action list.
function withoutRetiredActions(grants: unknown): unknown {
	if (!Array.isArray(grants)) {
		return grants;
	}

	const items: readonly unknown[] = grants;

	return items
		.map((grant) => {
			const parsed = grantWithActionsSchema.safeParse(grant);

			if (!parsed.success) {
				return grant;
			}

			return {
				...parsed.data,
				actions: parsed.data.actions.filter(
					(action) => typeof action === 'string' && knownOperations.has(action)
				)
			};
		})
		.filter((grant) => {
			const parsed = grantWithActionsSchema.safeParse(grant);

			return !parsed.success || parsed.data.actions.length > 0;
		});
}

// The retired selector spelling. No request uses it any more, but a document
// stored before the cutover still spells a cache this way, and this build
// stores it until a deploy records `contracted`, so the upgrades below read
// it and the spelling functions at the end of this file write it.
const legacyDefaultCacheSelector = '_default';
const legacyPrivateSelectorPrefix = '_private-';

const legacyCacheBindingSchema = z.looseObject({
	exact: z.string().optional(),
	equalsTemplate: z.string().optional()
});
const legacyCacheGrantSchema = z.looseObject({
	type: z.literal('cupboard_cache'),
	resources: z.looseObject({ cache: z.looseObject({}) })
});

// A rule in the selector spelling, which the previous build stored and this
// build stores until a deploy records `contracted`, has no `kind` and spells
// the default and private caches into the bound value: `_default` for the
// default cache, and a `_private-` prefix on an exact value or at the start of
// a template for a private one. Rewrite it into the current shape, in which
// the binding identifies the cache by scope, independent of its access.
function withUpgradedCacheBindings(grants: unknown): unknown {
	if (!Array.isArray(grants)) {
		return grants;
	}

	const items: readonly unknown[] = grants;

	return items.map((grant) => {
		const parsed = legacyCacheGrantSchema.safeParse(grant);

		if (!parsed.success || 'kind' in parsed.data.resources.cache) {
			return grant;
		}

		const binding = legacyCacheBindingSchema.parse(parsed.data.resources.cache);

		return {
			...parsed.data,
			resources: {
				...parsed.data.resources,
				cache: upgradedCacheBinding(binding)
			}
		};
	});
}

function upgradedCacheBinding(binding: {
	readonly exact?: string;
	readonly equalsTemplate?: string;
}): unknown {
	if (
		binding.exact === legacyDefaultCacheSelector ||
		binding.equalsTemplate === legacyDefaultCacheSelector
	) {
		return { kind: 'default' };
	}

	if (binding.exact?.startsWith(legacyPrivateSelectorPrefix) === true) {
		return {
			...binding,
			kind: 'named',
			exact: binding.exact.slice(legacyPrivateSelectorPrefix.length)
		};
	}

	if (
		binding.equalsTemplate?.startsWith(legacyPrivateSelectorPrefix) === true
	) {
		return {
			...binding,
			kind: 'named',
			equalsTemplate: binding.equalsTemplate.slice(
				legacyPrivateSelectorPrefix.length
			)
		};
	}

	return { ...binding, kind: 'named' };
}

/**
 * Validates stored trust-rule grants from both current and earlier releases.
 * Before strict validation, the preprocessor upgrades a cache binding written
 * in the selector spelling, then removes retired operations and any
 * non-wildcard grant with no recognised operation. An upgrade that narrows the
 * operation set therefore does not invalidate the stored rule.
 */
export const storedPermittedGrantsSchema = z.preprocess(
	(grants) => withoutRetiredActions(withUpgradedCacheBindings(grants)),
	z
		.array(permittedGrantSchema)
		.transform((grants) =>
			new Map(grants.map((grant) => [JSON.stringify(grant), grant]))
				.values()
				.toArray()
		)
);

const legacyIssuedCacheGrantSchema = z.looseObject({
	type: z.literal('cupboard_cache'),
	cache: z.string()
});

/**
 * Validates grants recorded by a refresh-token family. Until a deploy records
 * `contracted`, the family stores cache selectors for rollback compatibility.
 * The preprocessor converts those selectors to scopes before validation.
 */
export const storedAuthorizationDetailsSchema = z.preprocess(
	(grants) => {
		if (!Array.isArray(grants)) {
			return grants;
		}

		const items: readonly unknown[] = grants;

		return items.map((grant) => {
			const parsed = legacyIssuedCacheGrantSchema.safeParse(grant);

			return parsed.success
				? { ...parsed.data, cache: scopeFromSelectorText(parsed.data.cache) }
				: grant;
		});
	},
	authorizationDetailsSchema.transform((grants) =>
		new Map(grants.map((grant) => [JSON.stringify(grant), grant]))
			.values()
			.toArray()
	)
);

function scopeFromSelectorText(selector: string): unknown {
	if (selector === legacyDefaultCacheSelector) {
		return { kind: 'default' };
	}

	return {
		kind: 'named',
		name: selector.startsWith(legacyPrivateSelectorPrefix)
			? selector.slice(legacyPrivateSelectorPrefix.length)
			: selector
	};
}

/**
 * The access to spell a named cache with, or undefined when the tenant holds
 * no cache of that name.
 */
export type CacheAccessLookup = (
	name: CacheName
) => CacheAccessMode | undefined;

/**
 * A cache binding as a build before the scope spelling stores it. The bound
 * value is a selector: `_default` for the default cache, the name of a public
 * cache or `_private-<name>` for a private one.
 */
export interface SelectorSpelledCacheBinding {
	readonly equalsTemplate?: string;
	readonly exact?: string;
	readonly substitutions?: Record<string, Substitution>;
	readonly validate: 'cacheName';
}

type CachePermittedGrant = Extract<PermittedGrant, { type: 'cupboard_cache' }>;

export type SelectorSpelledPermittedGrant =
	| Exclude<PermittedGrant, { type: 'cupboard_cache' }>
	| (Omit<CachePermittedGrant, 'resources'> & {
			readonly resources: Omit<CachePermittedGrant['resources'], 'cache'> & {
				readonly cache: SelectorSpelledCacheBinding;
			};
	  });

type CacheAuthorizationDetail = Extract<
	AuthorizationDetail,
	{ type: 'cupboard_cache' }
>;

export type SelectorSpelledAuthorizationDetail =
	| Exclude<AuthorizationDetail, { type: 'cupboard_cache' }>
	| (Omit<CacheAuthorizationDetail, 'cache'> & {
			readonly cache: string;
	  });

/**
 * The selector that spells a scope together with the cache's access:
 * `_default` for the default cache, `_private-<name>` for a private named
 * cache and the name alone for a public one. `scopeFromSelectorText` reads
 * it back.
 */
function selectorForScope(scope: CacheScope, access: CacheAccessMode): string {
	if (scope.kind === 'default') {
		return legacyDefaultCacheSelector;
	}

	return access === 'private'
		? `${legacyPrivateSelectorPrefix}${scope.name}`
		: scope.name;
}

// A bound name that is not a cache name matches no cache in either spelling,
// so it is stored as it is.
function selectorForBoundName(
	name: string,
	accessOf: CacheAccessLookup
): string {
	const parsed = cacheNameSchema.safeParse(name);

	if (!parsed.success) {
		return name;
	}

	return selectorForScope(
		{ kind: 'named', name: parsed.data },
		accessOf(parsed.data) ?? 'public'
	);
}

function selectorSpelledCacheBinding(
	binding: CachePermittedGrant['resources']['cache'],
	accessOf: CacheAccessLookup
): SelectorSpelledCacheBinding {
	if (binding.kind === 'default') {
		return { exact: legacyDefaultCacheSelector, validate: 'cacheName' };
	}

	const { kind: _kind, ...bound } = binding;

	if (bound.exact === undefined) {
		return bound;
	}

	return { ...bound, exact: selectorForBoundName(bound.exact, accessOf) };
}

export class SelectorTemplateUnrepresentableError extends Error {
	constructor() {
		super(
			'This cache template is too long for the previous grant format. Complete the deployment before adding this rule.'
		);
		this.name = 'SelectorTemplateUnrepresentableError';
	}
}

/**
 * Spells trust-rule grants the way a build before the scope spelling stores
 * them, so that such a build parses the row after a rollback.
 * `storedPermittedGrantsSchema` reads the result back into `grants`.
 *
 * A named cache is spelled with its current access, so the previous build
 * matches the same cache. If the caller cannot determine a named cache's
 * access, store both selector forms. This covers unregistered caches and
 * control-plane rules, which do not inspect tenant cache state.
 * A template is stored in both public and private selector forms so either
 * access mode retains its authority after rollback. The current reader
 * coalesces those equivalent grants.
 */

export function permittedGrantsInSelectorSpelling(
	grants: readonly PermittedGrant[],
	accessOf: CacheAccessLookup
): SelectorSpelledPermittedGrant[] {
	return grants.flatMap((grant): SelectorSpelledPermittedGrant[] => {
		if (grant.type !== 'cupboard_cache') {
			return [grant];
		}
		const cache = selectorSpelledCacheBinding(grant.resources.cache, accessOf);
		const spelled = { ...grant, resources: { ...grant.resources, cache } };
		if (cache.equalsTemplate === undefined) {
			const name = cacheNameSchema.safeParse(cache.exact);
			if (name.success && accessOf(name.data) === undefined) {
				return [
					spelled,
					{
						...spelled,
						resources: {
							...spelled.resources,
							cache: {
								...cache,
								exact: `${legacyPrivateSelectorPrefix}${name.data}`
							}
						}
					}
				];
			}
			return [spelled];
		}
		const privateTemplate = `${legacyPrivateSelectorPrefix}${cache.equalsTemplate}`;
		if (privateTemplate.length > templateMaxLength) {
			throw new SelectorTemplateUnrepresentableError();
		}
		return [
			spelled,
			{
				...spelled,
				resources: {
					...spelled.resources,
					cache: { ...cache, equalsTemplate: privateTemplate }
				}
			}
		];
	});
}

/**
 * Spells the issued grants a refresh-token family records the way a build
 * before the scope spelling stores them, with the same rules as
 * `permittedGrantsInSelectorSpelling`. `storedAuthorizationDetailsSchema`
 * reads the result back into `grants`.
 */
export function authorizationDetailsInSelectorSpelling(
	grants: readonly AuthorizationDetail[],
	accessOf: CacheAccessLookup
): SelectorSpelledAuthorizationDetail[] {
	return grants.flatMap((grant): SelectorSpelledAuthorizationDetail[] => {
		if (grant.type !== 'cupboard_cache') {
			return [grant];
		}
		const { cache } = grant;
		const access = cache.kind === 'named' ? accessOf(cache.name) : 'public';
		const spelled = {
			...grant,
			cache: selectorForScope(cache, access ?? 'public')
		};
		if (access === undefined && cache.kind === 'named') {
			return [spelled, { ...grant, cache: selectorForScope(cache, 'private') }];
		}
		return [spelled];
	});
}
