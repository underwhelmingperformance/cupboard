import {
	cacheSelectorSchema,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
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

import { baseProcedure } from './base.ts';

// Both listing routes accept the opaque cursor from the previous page and a
// limit within the shared page bound.
const listPageQuerySchema = z
	.strictObject({
		cursor: z.string().min(1).optional(),
		limit: z.number().int().min(1).max(rootListPageSize).optional()
	})
	.default({});

export const rootsContract = {
	list: baseProcedure
		.meta({
			requires: 'root:list',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({
			method: 'GET',
			path: '/cache/{cacheName}/roots',
			inputStructure: 'detailed'
		})
		.input(
			// The detailed shape also carries headers and body, so the top level
			// stays open; the parts we consume are strict.
			z.object({
				params: z.strictObject({ cacheName: cacheSelectorSchema }),
				query: listPageQuerySchema
			})
		)
		.output(rootListResponseSchema),

	// Fetch targets one bounded page at a time. Each page checks whether its
	// targets can be served, so a run root can grow beyond one request and remain
	// listable.
	targets: baseProcedure
		.meta({
			requires: 'root:list',
			resource: { cache: { field: 'cacheName' }, root: { field: 'name' } }
		})
		.route({
			method: 'GET',
			path: '/cache/{cacheName}/roots/{name}/targets',
			inputStructure: 'detailed'
		})
		.input(
			z.object({
				params: z.strictObject({
					cacheName: cacheSelectorSchema,
					name: rootNameSchema
				}),
				query: listPageQuerySchema
			})
		)
		.output(rootTargetsPageSchema),

	// The token must grant `root:set` for both this cache and this root. An empty
	// target list clears the targets but keeps the root and its expiry. The CLI's
	// `root set` and `root ensure` commands require at least one store path, so
	// clearing a root requires a direct request with an empty list.
	set: baseProcedure
		.meta({
			requires: 'root:set',
			resource: { cache: { field: 'cacheName' }, root: { field: 'name' } },
			maintenance: true
		})
		.route({ method: 'PUT', path: '/cache/{cacheName}/roots/{name}' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				name: rootNameSchema,
				...rootSetBodySchema.shape
			})
		)
		.output(rootSetResponseSchema),

	ensure: baseProcedure
		.meta({
			requires: 'root:set',
			resource: { cache: { field: 'cacheName' }, root: { field: 'name' } },
			maintenance: true
		})
		.route({ method: 'POST', path: '/cache/{cacheName}/roots/{name}/ensure' })
		.input(
			z.strictObject({
				cacheName: cacheSelectorSchema,
				name: rootNameSchema,
				...rootEnsureBodySchema.shape
			})
		)
		.output(rootEnsureResponseSchema),

	remove: baseProcedure
		.meta({
			requires: 'root:remove',
			resource: { cache: { field: 'cacheName' }, root: { field: 'name' } },
			maintenance: true
		})
		.route({ method: 'DELETE', path: '/cache/{cacheName}/roots/{name}' })
		.input(
			z.strictObject({ cacheName: cacheSelectorSchema, name: rootNameSchema })
		)
		.output(rootRemoveResponseSchema)
};
