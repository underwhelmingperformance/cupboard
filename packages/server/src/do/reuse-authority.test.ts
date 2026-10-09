import {
	type CacheAccessMode,
	cacheNameSchema,
	type CacheScope
} from '@cupboard/nix-store/scalars';
import { authorizationDetailsSchema } from '@cupboard/protocol/grants';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import { describe, expect, it } from 'vitest';

import {
	ReuseAuthority,
	reuseGrants,
	type ReuseViewMembership
} from './reuse-authority.ts';

const destination: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('pr-builds')
};
const source: CacheScope = {
	kind: 'named',
	name: cacheNameSchema.parse('falcon')
};
const view = reuseViewNameSchema.parse('falcon-view');

const writeOnDestination = {
	type: 'cupboard_cache',
	actions: ['upload:negotiate', 'upload:commit'],
	cache: destination
};

const sourceView: ReuseViewMembership = {
	view,
	access: 'private',
	caches: [source]
};

describe('ReuseAuthority', () => {
	it.each<{
		readonly name: string;
		readonly reference: { cache: CacheScope; access: CacheAccessMode };
		readonly grants: readonly object[];
		readonly views: readonly ReuseViewMembership[];
		readonly permits: boolean;
	}>([
		{
			name: 'a private destination',
			reference: { cache: destination, access: 'private' },
			grants: [writeOnDestination],
			views: [],
			permits: true
		},
		{
			name: 'a public cache',
			reference: { cache: source, access: 'public' },
			grants: [writeOnDestination],
			views: [],
			permits: true
		},
		{
			name: 'a private cache covered for content reads',
			reference: { cache: source, access: 'private' },
			grants: [
				writeOnDestination,
				{
					type: 'cupboard_cache',
					actions: ['cache:content-read'],
					cache: source
				}
			],
			views: [],
			permits: true
		},
		{
			name: 'a private cache in a view covered for content reads',
			reference: { cache: source, access: 'private' },
			grants: [
				writeOnDestination,
				{ type: 'cupboard_view', actions: ['view:content-read'], view }
			],
			views: [sourceView],
			permits: true
		},
		{
			name: 'a private cache under a wildcard grant',
			reference: { cache: source, access: 'private' },
			grants: [{ type: 'cupboard_wildcard' }],
			views: [],
			permits: true
		},
		{
			name: 'a private cache with only metadata reads',
			reference: { cache: source, access: 'private' },
			grants: [
				writeOnDestination,
				{ type: 'cupboard_cache', actions: ['cache:read'], cache: source }
			],
			views: [sourceView],
			permits: false
		},
		{
			name: 'a private cache in a view without a view grant',
			reference: { cache: source, access: 'private' },
			grants: [writeOnDestination],
			views: [sourceView],
			permits: false
		},
		{
			name: 'a private cache whose access differs from the covered view',
			reference: { cache: source, access: 'private' },
			grants: [
				writeOnDestination,
				{ type: 'cupboard_view', actions: ['view:content-read'], view }
			],
			views: [{ ...sourceView, access: 'public' }],
			permits: false
		}
	])(
		'decides a reference from $name',
		({ reference, grants, views, permits }) => {
			const parsed = authorizationDetailsSchema.parse(grants);
			const isPermittedWith = (retained: typeof parsed) =>
				new ReuseAuthority({
					destination,
					grants: retained,
					views
				}).permits(reference);

			expect({
				withAllGrants: isPermittedWith(parsed),
				withReuseGrants: isPermittedWith(reuseGrants(parsed))
			}).toStrictEqual({ withAllGrants: permits, withReuseGrants: permits });
		}
	);
});
