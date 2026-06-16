import {
	type PermittedGrant,
	permittedGrantSchema
} from '@cupboard/protocol/grants';
import {
	type OidcTrustAddBody,
	oidcTrustAddBodySchema
} from '@cupboard/protocol/oidc';

import { InvalidClaimError } from '../../errors.ts';

// The cache operations each `--allow` shorthand expands to. `push` and `attest`
// are the upload and attestation conversations; `root` is a retention-root write.
const allowExpansions = {
	push: [
		'upload:negotiate',
		'upload:prepare',
		'upload:status',
		'upload:commit'
	],
	attest: [
		'attestation:negotiate',
		'attestation:prepare',
		'attestation:attach'
	],
	root: ['root:set']
} as const;

export type AllowShorthand = keyof typeof allowExpansions;

export class UnknownAllowError extends Error {
	constructor(public readonly value: string) {
		super(
			`Unknown --allow value '${value}'. Expected one of: ${Object.keys(allowExpansions).join(', ')}.`
		);
		this.name = 'UnknownAllowError';
	}
}

export class MissingCacheError extends Error {
	constructor() {
		super('A cache grant needs --cache <name>.');
		this.name = 'MissingCacheError';
	}
}

export function expandAllow(values: readonly string[]): {
	cacheActions: string[];
	rootActions: string[];
} {
	const cacheActions = new Set<string>();
	const rootActions = new Set<string>();

	for (const value of values) {
		if (!(value in allowExpansions)) {
			throw new UnknownAllowError(value);
		}

		for (const action of allowExpansions[value as AllowShorthand]) {
			(value === 'root' ? rootActions : cacheActions).add(action);
		}
	}

	return { cacheActions: [...cacheActions], rootActions: [...rootActions] };
}

export interface CacheGrantOptions {
	readonly cache?: string;
	readonly allow: readonly string[];
	readonly root?: string;
}

// Build the single cache grant a `--allow`/`--cache`/`--root` set describes: an
// exact cache binding, and a root binding that is either the cache itself
// (`--root same-as-cache`) or an exact name.
export function buildCacheGrant(options: CacheGrantOptions): PermittedGrant {
	const { cacheActions, rootActions } = expandAllow(options.allow);

	if (options.cache === undefined) {
		throw new MissingCacheError();
	}

	const wantsRoot = rootActions.length > 0 || options.root !== undefined;

	return permittedGrantSchema.parse({
		type: 'cupboard_cache',
		actions: [...cacheActions, ...rootActions],
		resources: {
			cache: { exact: options.cache, validate: 'cacheName' },
			...(wantsRoot ? { root: rootBinding(options.root) } : {})
		}
	});
}

function rootBinding(root: string | undefined): {
	readonly validate: 'rootName';
	readonly equalsResource?: 'cache';
	readonly exact?: string;
} {
	if (root === undefined || root === 'same-as-cache') {
		return { validate: 'rootName', equalsResource: 'cache' };
	}

	return { validate: 'rootName', exact: root };
}

export interface AddBodyOptions {
	readonly issuer: string;
	readonly audience: string;
	readonly claims: Record<string, string>;
	readonly permittedGrants: readonly PermittedGrant[];
}

// Validate the assembled rule against the contract schema, so the CLI fails on a
// malformed grant before the request leaves the machine.
export function buildAddBody(options: AddBodyOptions): OidcTrustAddBody {
	const parsed = oidcTrustAddBodySchema.safeParse({
		issuer: options.issuer,
		audience: options.audience,
		claims: options.claims,
		permittedGrants: options.permittedGrants
	});

	if (!parsed.success) {
		throw new InvalidClaimError(parsed.error.message);
	}

	return parsed.data;
}
