import { readUserSchema } from '@cupboard/shared/http';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { ReadCredentialPairError } from '../errors.ts';
import { readCredentialVariables } from '../test-support.ts';

import { readCredentials } from './read-credentials.ts';

function credentialsOrError(
	...parameters: Parameters<typeof readCredentials>
): unknown {
	try {
		return readCredentials(...parameters);
	} catch (error: unknown) {
		return error;
	}
}

describe('readCredentials', () => {
	beforeEach(() => {
		for (const variable of readCredentialVariables) {
			vi.stubEnv(variable, undefined);
		}
	});

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	const roles = [
		{
			target: 'cache',
			variables: {
				user: 'CUPBOARD_READ_USER',
				password: 'CUPBOARD_READ_PASSWORD'
			}
		},
		{
			target: 'view',
			variables: {
				user: 'CUPBOARD_VIEW_READ_USER',
				password: 'CUPBOARD_VIEW_READ_PASSWORD'
			}
		}
	] as const;

	// GitHub Actions sets an empty string when the secret or input behind a
	// variable is unset.
	it.each(
		roles.flatMap((role) =>
			[
				{ name: 'an empty user', user: '', password: undefined },
				{ name: 'an empty password', user: undefined, password: '' },
				{ name: 'an empty user and password', user: '', password: '' }
			].map((values) => ({ ...role, ...values }))
		)
	)(
		'treats $name in the $target variables as unset',
		({ target, variables, user, password }) => {
			vi.stubEnv(variables.user, user);
			vi.stubEnv(variables.password, password);

			expect(credentialsOrError({}, target)).toBeUndefined();
		}
	);

	it.each(
		roles.flatMap((role) => [
			{ ...role, name: 'an empty user', user: '', password: 'secret' },
			{ ...role, name: 'an empty password', user: 'reader', password: '' }
		])
	)(
		'rejects $name in the $target variables with the other half set',
		({ target, variables, user, password }) => {
			vi.stubEnv(variables.user, user);
			vi.stubEnv(variables.password, password);

			expect(credentialsOrError({}, target)).toStrictEqual(
				new ReadCredentialPairError(target, variables)
			);
		}
	);

	it('keeps an empty password option', () => {
		expect(
			credentialsOrError({
				readUser: readUserSchema.parse('reader'),
				readPassword: ''
			})
		).toStrictEqual({ user: readUserSchema.parse('reader'), password: '' });
	});
});
