import { rootNameSchema } from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	rootBatchBodySchema,
	rootBatchLimitErrorCode,
	rootBatchLimitErrorDataSchema,
	rootBatchResponseSchema,
	rootEnsureBodySchema,
	rootEnsureResponseSchema,
	rootListPageSize,
	rootListResponseSchema,
	rootRemoveResponseSchema,
	rootSetBodySchema,
	rootSetResponseSchema,
	rootTargetsPageSchema
} from '../retention.ts';
import { pushIdSchema } from '../upload.ts';

import {
	cacheRemovedErrors,
	cacheScopedProcedure,
	writableCacheScopedProcedure
} from './cache-scoped.ts';

// Both listing routes accept the opaque cursor from the previous page and a
// limit within the shared page bound. They are GET routes, so oRPC sends any
// field that is not a path parameter in the query string.
const listPageShape = {
	cursor: z.string().min(1).optional(),
	limit: z.number().int().min(1).max(rootListPageSize).optional()
};

const retentionMigrationPendingError = {
	CACHE_RETENTION_MIGRATION_PENDING: { status: 409 }
};

// A push sends its push ID with the root writes of the push, but only when the
// server echoed `push-root-writes` on the push's credential request. The
// server then refuses the write when the push started before the cache was
// removed. A root write without a push ID is not part of a push.
const rootWriteErrors = {
	...retentionMigrationPendingError,
	...cacheRemovedErrors
};
const pushShape = { pushId: pushIdSchema.optional() };

const rootSet = writableCacheScopedProcedure(
	{
		method: 'PUT',
		suffix: '/roots/{name}',
		requires: 'root:set',
		resource: { root: { field: 'name' } },
		maintenance: true,
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	{ name: rootNameSchema, ...rootSetBodySchema.shape, ...pushShape },
	rootSetResponseSchema
);

const rootEnsure = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/roots/{name}/ensure',
		requires: 'root:set',
		resource: { root: { field: 'name' } },
		maintenance: true,
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	{ name: rootNameSchema, ...rootEnsureBodySchema.shape, ...pushShape },
	rootEnsureResponseSchema
);

const rootBatch = writableCacheScopedProcedure(
	{
		method: 'POST',
		suffix: '/roots/batch',
		requires: 'root:set',
		resource: { root: { eachIn: 'roots', field: 'name' } },
		maintenance: true,
		replaySafety: 'replay-safe',
		workBound: 'size'
	},
	{ ...rootBatchBodySchema.shape, ...pushShape },
	rootBatchResponseSchema
);

const rootBatchErrors = {
	...rootWriteErrors,
	[rootBatchLimitErrorCode]: {
		status: 413,
		data: rootBatchLimitErrorDataSchema
	}
};

export const rootsContract = {
	list: cacheScopedProcedure(
		{
			method: 'GET',
			suffix: '/roots',
			requires: 'root:list',
			replaySafety: 'replay-safe',
			workBound: 'time'
		},
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
			resource: { root: { field: 'name' } },
			replaySafety: 'replay-safe',
			workBound: 'size'
		},
		{ name: rootNameSchema, ...listPageShape },
		rootTargetsPageSchema
	),

	// The token must grant `root:set` for both this cache and this root. An empty
	// target list clears the targets but keeps the root. The CLI's `root set`
	// and `root ensure` commands require at least one store path, so
	// clearing a root requires a direct request with an empty list.
	set: {
		inDefaultCache: rootSet.inDefaultCache.errors(rootWriteErrors),
		inNamedCache: rootSet.inNamedCache.errors(rootWriteErrors)
	},

	ensure: {
		inDefaultCache: rootEnsure.inDefaultCache.errors(rootWriteErrors),
		inNamedCache: rootEnsure.inNamedCache.errors(rootWriteErrors)
	},

	// Set or ensure several roots in one request. The token must grant
	// `root:set` for this cache and for every root in the batch. Each entry has
	// the effect of the single set or ensure request for its root. A repeated
	// batch, like a repeated single request, keeps unchanged target sets and
	// only refreshes each root's expiry and update time.
	batch: {
		inDefaultCache: rootBatch.inDefaultCache.errors(rootBatchErrors),
		inNamedCache: rootBatch.inNamedCache.errors(rootBatchErrors)
	},

	// Removal keeps the default. A retry sent after the name was bound to a new
	// root would delete that one.
	remove: cacheScopedProcedure(
		{
			method: 'DELETE',
			suffix: '/roots/{name}',
			requires: 'root:remove',
			resource: { root: { field: 'name' } },
			maintenance: true,
			workBound: 'time'
		},
		{ name: rootNameSchema },
		rootRemoveResponseSchema
	)
};
