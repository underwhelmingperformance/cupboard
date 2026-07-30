import {
	cacheSelectorSchema,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	rootEnsureResponseSchema,
	rootListPageSize,
	rootListResponseSchema,
	rootRemoveResponseSchema,
	rootSetBodySchema,
	rootSetResponseSchema,
	rootTargetsPageSchema
} from '../retention.ts';

import { baseProcedure } from './base.ts';

// The listings page through query parameters: an opaque cursor resumes where
// the previous page stopped, and the limit stays within the shared page bound.
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

	// A root's targets, one bounded page at a time: the per-target serve probe
	// runs per page, so a run root grown past any single request stays
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

	// CI sets roots with a token whose grant names the cache and root; the
	// authoriser enforces both from the grant.
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
				...rootSetBodySchema.shape
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
