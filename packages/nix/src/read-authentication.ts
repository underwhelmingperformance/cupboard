import { readFile } from 'node:fs/promises';

import { basicAuthHeader, readUserInputSchema } from '@cupboard/shared/http';

import { netrcCredentialFor } from './netrc.ts';
import { discoverNixStoreConfig } from './store-config.ts';

export interface ReadAuthenticationOptions {
	readonly tenantUrl: URL;
	readonly netrcFile?: string;
	readonly readFile?: (
		file: string,
		encoding: BufferEncoding
	) => Promise<string>;
}

export function withReadAuthentication(
	fetcher: typeof fetch,
	options: ReadAuthenticationOptions
): typeof fetch {
	const netrcFile =
		options.netrcFile ?? discoverNixStoreConfig().fileTransfer.netrcFile;
	const tenantUrl = options.tenantUrl;
	const read = options.readFile ?? readFile;
	const tenantPath = tenantUrl.pathname.replace(/\/$/u, '');

	return async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : input);
		const headers = new Headers(
			init?.headers ?? (input instanceof Request ? input.headers : undefined)
		);

		if (
			headers.has('authorization') ||
			url.username !== '' ||
			url.password !== '' ||
			url.origin !== tenantUrl.origin ||
			(url.pathname !== tenantPath &&
				!url.pathname.startsWith(`${tenantPath}/`))
		) {
			return fetcher(input, init);
		}

		let contents: string;
		try {
			contents = await read(netrcFile, 'utf8');
		} catch (error) {
			if (
				error instanceof Error &&
				'code' in error &&
				['ENOENT', 'EACCES', 'EPERM'].includes(String(error.code))
			) {
				return fetcher(input, init);
			}

			throw error;
		}

		const credential = netrcCredentialFor(contents, url.hostname);

		if (credential === undefined) {
			return fetcher(input, init);
		}

		headers.set(
			'authorization',
			basicAuthHeader({
				user: readUserInputSchema.parse(credential.login),
				password: credential.password
			}).authorization
		);

		return fetcher(input, { ...init, headers });
	};
}
