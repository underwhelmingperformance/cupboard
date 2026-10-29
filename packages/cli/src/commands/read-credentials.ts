import { env } from 'node:process';

import type { BasicCredential, ReadUser } from '@cupboard/shared/http';

import { ReadCredentialPairError } from '../errors.ts';
import { parseReadUser } from '../read-user.ts';

interface ReadCredentialOptions {
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly viewReadUser?: ReadUser;
	readonly viewReadPassword?: string;
}

interface CredentialVariables {
	readonly user: string;
	readonly password: string;
}

const cacheVariables: CredentialVariables = {
	user: 'CUPBOARD_READ_USER',
	password: 'CUPBOARD_READ_PASSWORD'
};

const viewVariables: CredentialVariables = {
	user: 'CUPBOARD_VIEW_READ_USER',
	password: 'CUPBOARD_VIEW_READ_PASSWORD'
};

/**
Returns the read credential for the cache or for the reuse view. Each half
that the options omit comes from `CUPBOARD_READ_USER` and
`CUPBOARD_READ_PASSWORD`, or from `CUPBOARD_VIEW_READ_USER` and
`CUPBOARD_VIEW_READ_PASSWORD` for the reuse view. Automation passes passwords
in the environment so that they do not appear in the process's arguments.
*/
export function readCredentials(
	options: ReadCredentialOptions,
	target: 'cache' | 'view' = 'cache'
): BasicCredential | undefined {
	return target === 'view'
		? pairedCredential(
				options.viewReadUser,
				options.viewReadPassword,
				viewVariables,
				target
			)
		: pairedCredential(
				options.readUser,
				options.readPassword,
				cacheVariables,
				target
			);
}

/**
Returns the read credential that `push` sends to its `--reference-source`. Each
half that `--read-user` and `--read-password` omit comes from
`CUPBOARD_VIEW_READ_USER` and `CUPBOARD_VIEW_READ_PASSWORD`, which the plan
commands also read for a reference source. Other commands read
`CUPBOARD_READ_USER` and `CUPBOARD_READ_PASSWORD` for the cache that they
address, so push does not send those variables to a different cache.
*/
export function referenceSourceCredentials(
	options: Pick<ReadCredentialOptions, 'readUser' | 'readPassword'>
): BasicCredential | undefined {
	return pairedCredential(
		options.readUser,
		options.readPassword,
		viewVariables,
		'cache'
	);
}

/**
Returns the value of an environment variable, or undefined when it is unset or
empty. GitHub Actions sets a variable to an empty string when the secret or
input behind it is unset.
*/
export function environmentValue(name: string): string | undefined {
	const value = env[name];

	return value === '' ? undefined : value;
}

function pairedCredential(
	optionUser: ReadUser | undefined,
	optionPassword: string | undefined,
	variables: CredentialVariables,
	target: 'cache' | 'view'
): BasicCredential | undefined {
	const user = optionUser ?? parseReadUser(environmentValue(variables.user));
	const password = optionPassword ?? environmentValue(variables.password);

	if ((user === undefined) !== (password === undefined)) {
		throw new ReadCredentialPairError(target, variables);
	}

	if (user === undefined || password === undefined) {
		return undefined;
	}

	return { user, password };
}
