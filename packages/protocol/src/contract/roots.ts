import { rootNameSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	rootEnsureBodySchema,
	rootEnsureResponseSchema,
	rootListPageSize,
	rootListResponseSchema,
	rootRemoveResponseSchema,
	rootSetBodySchema,
	rootSetResponseSchema,
	rootTargetsPageSchema
} from '../retention.ts';

import { cacheScopedProcedure } from './cache-scoped.ts';

// Both listing routes accept the opaque cursor from the previous page and a
// limit within the shared page bound. Both are GET routes, so oRPC sends every
// field the path does not name in the query string.
const listPageShape = {
	cursor: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(rootListPageSize).optional()
};

export const rootsContract = {
	list: cacheScopedProcedure(
		{ method: 'GET', suffix: '/roots', requires: 'root:list' },
		listPageShape,
		rootListResponseSchema
	),

	// Fetch targets one bounded page at a time. Each page checks whether its
	// targets can be served, so a run root can grow beyond one request and remain
	// listable.
	targets: cacheScopedProcedure(
		{
			method: 'GET',
			suffix: '/roots/{name}/targets',
			requires: 'root:list',
			resource: { root: { field: 'name' } }
		},
		{ name: rootNameSchema, ...listPageShape },
		rootTargetsPageSchema
	),

	// The token must grant `root:set` for both this cache and this root. An empty
	// target list clears the targets but keeps the root and its expiry. The CLI's
	// `root set` and `root ensure` commands require at least one store path, so
	// clearing a root requires a direct request with an empty list.
	set: cacheScopedProcedure(
		{
			method: 'PUT',
			suffix: '/roots/{name}',
			requires: 'root:set',
			resource: { root: { field: 'name' } },
			maintenance: true
		},
		{ name: rootNameSchema, ...rootSetBodySchema.shape },
		rootSetResponseSchema
	),

	ensure: cacheScopedProcedure(
		{
			method: 'POST',
			suffix: '/roots/{name}/ensure',
			requires: 'root:set',
			resource: { root: { field: 'name' } },
			maintenance: true
		},
		{ name: rootNameSchema, ...rootEnsureBodySchema.shape },
		rootEnsureResponseSchema
	),

	remove: cacheScopedProcedure(
		{
			method: 'DELETE',
			suffix: '/roots/{name}',
			requires: 'root:remove',
			resource: { root: { field: 'name' } },
			maintenance: true
		},
		{ name: rootNameSchema },
		rootRemoveResponseSchema
	)
};
