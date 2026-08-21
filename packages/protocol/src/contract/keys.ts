import {
	authKeyIdSchema,
	signingKeyIdSchema
} from '@cupboard/nix-store/scalars';
import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import {
	authKeyListResponseSchema,
	authKeyRetireResponseSchema,
	authKeyRotateResponseSchema,
	keyAbortResponseSchema,
	keyListResponseSchema,
	keyRetireResponseSchema,
	keyRotateResponseSchema
} from '../keys.ts';

import { baseProcedure } from './base.ts';

export const keysContract = {
	// The narinfo signing keys Nix verifies against.
	signing: {
		list: baseProcedure
			.meta({ requires: 'signing-key:list' })
			.route({ method: 'GET', path: '/keys' })
			.output(keyListResponseSchema),

		rotate: baseProcedure
			.meta({ requires: 'signing-key:rotate' })
			.route({ method: 'POST', path: '/keys/rotate' })
			.errors({
				SIGNING_KEY_ROTATION_IN_PROGRESS: {
					status: StatusCodes.CONFLICT,
					data: z.strictObject({ id: signingKeyIdSchema })
				}
			})
			.output(keyRotateResponseSchema),

		retire: baseProcedure
			.meta({ requires: 'signing-key:retire' })
			.route({ method: 'POST', path: '/keys/retire/{id}' })
			.input(z.strictObject({ id: signingKeyIdSchema }))
			.errors({
				SIGNING_KEY_BACKFILL_INCOMPLETE: {
					status: StatusCodes.CONFLICT,
					data: z.strictObject({ id: signingKeyIdSchema })
				}
			})
			.output(keyRetireResponseSchema),

		abort: baseProcedure
			.meta({ requires: 'signing-key:retire' })
			.route({ method: 'POST', path: '/keys/abort/{id}' })
			.input(z.strictObject({ id: signingKeyIdSchema }))
			.errors({
				SIGNING_KEY_ROTATION_ABORT_NOT_ALLOWED: {
					status: StatusCodes.CONFLICT,
					data: z.strictObject({ id: signingKeyIdSchema })
				}
			})
			.output(keyAbortResponseSchema)
	},

	// The auth-token signing keys, rotated independently of the narinfo keys.
	auth: {
		list: baseProcedure
			.meta({ requires: 'auth-key:list' })
			.route({ method: 'GET', path: '/keys/auth' })
			.output(authKeyListResponseSchema),

		rotate: baseProcedure
			.meta({ requires: 'auth-key:rotate', maintenance: true })
			.route({ method: 'POST', path: '/keys/auth/rotate' })
			.output(authKeyRotateResponseSchema),

		retire: baseProcedure
			.meta({ requires: 'auth-key:retire', maintenance: true })
			.route({ method: 'POST', path: '/keys/auth/retire/{kid}' })
			.input(z.strictObject({ kid: authKeyIdSchema }))
			.output(authKeyRetireResponseSchema)
	}
};
