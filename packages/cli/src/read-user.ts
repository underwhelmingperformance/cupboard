import { randomBytes } from 'node:crypto';

import { readPasswordByteLength } from '@cupboard/protocol/tenants';
import { type ReadUser, readUserInputSchema } from '@cupboard/shared/http';

import { InvalidReadUserError } from './errors.ts';

/**
 * The `--read-user` option parser, also used for the `CUPBOARD_READ_USER`
 * fallback: a typed refusal instead of a raw ZodError, and `undefined` when
 * neither is set.
 */
export function parseReadUser(value: string | undefined): ReadUser | undefined {
	if (value === undefined) {
		return undefined;
	}

	const parsed = readUserInputSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidReadUserError(value);
	}

	return parsed.data;
}

/**
 * Creates a read password. A read password is generated and never chosen, so
 * the credential is protected by the password's own entropy.
 */
export function generateReadPassword(): string {
	return randomBytes(readPasswordByteLength).toString('base64url');
}
