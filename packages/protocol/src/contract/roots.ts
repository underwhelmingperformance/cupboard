import { cacheSelectorSchema, rootNameSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import {
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
