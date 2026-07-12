import {
	cacheSelectorSchema,
	rootNameSchema
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import {
	rootEnsureResponseSchema,
	rootListResponseSchema,
	rootRemoveResponseSchema,
	rootSetBodySchema,
	rootSetResponseSchema
} from '../retention.ts';

import { baseProcedure } from './base.ts';

export const rootsContract = {
	list: baseProcedure
		.meta({
			requires: 'root:list',
			resource: { cache: { field: 'cacheName' } }
		})
		.route({ method: 'GET', path: '/cache/{cacheName}/roots' })
		.input(z.strictObject({ cacheName: cacheSelectorSchema }))
		.output(rootListResponseSchema),

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
