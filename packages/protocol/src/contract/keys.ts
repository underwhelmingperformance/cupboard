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
	// Nix verifies narinfo signatures with these keys.
	signing: {
		list: baseProcedure
			.meta({ requires: 'signing-key:list', replaySafety: 'replay-safe' })
			.route({ method: 'GET', path: '/keys' })
			.output(keyListResponseSchema),

		// Rotation keeps the default. It inserts a key with a new id, advances the
		// generation sequence and starts a backfill, so a retry either meets the
		// first attempt's unfinished backfill and returns the conflict below, or
		// creates a second key once that backfill has completed. Auth-key rotation
		// inserts a key with a fresh `kid` on every call.
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

	// Auth-token keys rotate independently of the narinfo keys.
	auth: {
		list: baseProcedure
			.meta({ requires: 'auth-key:list', replaySafety: 'replay-safe' })
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
