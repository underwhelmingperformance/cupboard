import { signingKeyIdSchema } from '@cupboard/nix/scalars';
import { z } from 'zod';

import {
	authKeyListResponseSchema,
	authKeyRetireResponseSchema,
	authKeyRotateResponseSchema,
	keyListResponseSchema,
	keyRetireResponseSchema,
	keyRotateResponseSchema
} from '../keys.ts';

import { adminProcedure } from './base.ts';

export const keysContract = {
	// The narinfo signing keys Nix verifies against.
	signing: {
		list: adminProcedure
			.route({ method: 'GET', path: '/keys' })
			.output(keyListResponseSchema),

		rotate: adminProcedure
			.route({ method: 'POST', path: '/keys/rotate' })
			.output(keyRotateResponseSchema),

		retire: adminProcedure
			.route({ method: 'POST', path: '/keys/retire/{id}' })
			.input(z.strictObject({ id: signingKeyIdSchema }))
			.output(keyRetireResponseSchema)
	},

	// The auth-token signing keys, rotated independently of the narinfo keys.
	auth: {
		list: adminProcedure
			.route({ method: 'GET', path: '/keys/auth' })
			.output(authKeyListResponseSchema),

		rotate: adminProcedure
			.meta({ scope: 'admin', maintenance: true })
			.route({ method: 'POST', path: '/keys/auth/rotate' })
			.output(authKeyRotateResponseSchema),

		retire: adminProcedure
			.meta({ scope: 'admin', maintenance: true })
			.route({ method: 'POST', path: '/keys/auth/retire/{kid}' })
			.input(z.strictObject({ kid: z.string() }))
			.output(authKeyRetireResponseSchema)
	}
};
