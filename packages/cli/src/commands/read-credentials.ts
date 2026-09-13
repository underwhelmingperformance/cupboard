import type { BasicCredential, ReadUser } from '@cupboard/shared/http';

import { ReadCredentialPairError } from '../errors.ts';

interface ReadCredentialOptions {
	readonly readUser?: ReadUser;
	readonly readPassword?: string;
	readonly viewReadUser?: ReadUser;
	readonly viewReadPassword?: string;
}

export function readCredentials(
	options: ReadCredentialOptions,
	target: 'cache' | 'view' = 'cache'
): BasicCredential | undefined {
	const user = target === 'view' ? options.viewReadUser : options.readUser;
	const password =
		target === 'view' ? options.viewReadPassword : options.readPassword;

	if ((user === undefined) !== (password === undefined)) {
		throw new ReadCredentialPairError(target);
	}

	if (user === undefined || password === undefined) {
		return undefined;
	}

	return { user, password };
}
