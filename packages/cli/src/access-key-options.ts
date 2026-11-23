import { env } from 'node:process';

import {
	type AccessKeySecret,
	accessKeySecretSchema
} from '@cupboard/protocol/access-keys';
import { type Reporter } from '@cupboard/reporter';
import {
	type BasicCredential,
	readUserInputSchema
} from '@cupboard/shared/http';

import {
	type AccessCredential,
	type TokenProvider
} from './client/credentials.ts';
import {
	AccessKeyWithGithubOidcError,
	InvalidAccessKeyError,
	type PushCredential
} from './errors.ts';

/**
The access-key options of a command. `accessKey` is for the cache that the
command addresses, and `viewAccessKey` is for its reuse view or reference
source.
*/
export interface AccessKeyOptions {
	readonly accessKey?: AccessKeySecret;
	readonly viewAccessKey?: AccessKeySecret;
}

const accessKeyVariables = {
	cache: 'CUPBOARD_ACCESS_KEY',
	view: 'CUPBOARD_VIEW_ACCESS_KEY'
} as const;

// The server ignores the Basic user name of an access key, but netrc and Basic
// authentication need one, so cupboard always sends this one.
const accessKeyUser = readUserInputSchema.parse('cupboard');

/**
Parses the value of `--access-key` or `--view-access-key`.
*/
export function parseAccessKey(value: string): AccessKeySecret {
	return accessKeyFrom(value, 'The access key');
}

/**
Returns the access key for the addressed cache, or for the reuse view or
reference source when `target` is `view`. When the command's option is
absent, the key comes from `CUPBOARD_ACCESS_KEY` or `CUPBOARD_VIEW_ACCESS_KEY`.
Automation passes keys in the environment so that they do not appear in the
process's arguments.
*/
export function accessKeyFor(
	options: AccessKeyOptions,
	target: 'cache' | 'view' = 'cache'
): AccessKeySecret | undefined {
	const option = target === 'view' ? options.viewAccessKey : options.accessKey;

	if (option !== undefined) {
		return option;
	}

	const variable = accessKeyVariables[target];
	const value = environmentValue(variable);

	return value === undefined ? undefined : accessKeyFrom(value, variable);
}

/**
Returns the access key that replaces the login session of a command that
publishes or changes retention. A key replaces the job's OIDC token too, so a
key together with `--github-oidc` is refused. The reporter announces a key from
`CUPBOARD_ACCESS_KEY`, so that a key exported for another purpose does not
replace the session unnoticed.
*/
export function sessionReplacingAccessKey(
	options: AccessKeyOptions & { readonly githubOidc?: boolean },
	reporter: Pick<Reporter, 'info'>
): AccessKeySecret | undefined {
	const accessKey = accessKeyFor(options);

	if (accessKey === undefined) {
		return undefined;
	}

	if (options.githubOidc === true) {
		throw new AccessKeyWithGithubOidcError();
	}

	if (options.accessKey === undefined) {
		reporter.info(
			`Authenticating with the access key from ${accessKeyVariables.cache}.`
		);
	}

	return accessKey;
}

/**
Returns the access key for the addressed cache when one is configured, and
otherwise the credential that `authenticate` provides.
*/
export async function accessKeyOrAuthenticated(
	options: AccessKeyOptions & { readonly githubOidc?: boolean },
	reporter: Pick<Reporter, 'info'>,
	authenticate: () => Promise<TokenProvider>
): Promise<AccessCredential> {
	return sessionReplacingAccessKey(options, reporter) ?? authenticate();
}

/**
The kind of credential that a publishing command uses, for its error advice.
*/
export function pushCredentialKind(
	options: { readonly githubOidc?: boolean },
	accessKey: AccessKeySecret | undefined
): PushCredential {
	if (accessKey !== undefined) {
		return 'access-key';
	}

	return options.githubOidc === true ? 'github-oidc' : 'cupboard-login';
}

/**
The HTTP Basic credential that presents an access key.
*/
export function basicCredentialForAccessKey(
	key: AccessKeySecret
): BasicCredential {
	return { user: accessKeyUser, password: key };
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

function accessKeyFrom(value: string, source: string): AccessKeySecret {
	const parsed = accessKeySecretSchema.safeParse(value);

	if (!parsed.success) {
		throw new InvalidAccessKeyError(source);
	}

	return parsed.data;
}
