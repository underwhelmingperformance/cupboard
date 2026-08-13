import { NixConfigSettingError } from '@cupboard/nix';
import { describe, expect, it } from 'vitest';

import { InvalidStoreUriError } from './errors.ts';
import { parseStoreUri } from './store-uri.ts';

describe('parseStoreUri', () => {
	it.each([
		{ uri: 'ssh-ng://build@example.test' },
		{ uri: 'ssh-ng://example.test?remote-program=/opt/nix/bin/nix-daemon' }
	])('accepts $uri', ({ uri }) => {
		expect(parseStoreUri(uri)).toBe(uri);
	});

	it.each([
		{ name: 'the classic ssh scheme', uri: 'ssh://builder' },
		{ name: 'a store keyword', uri: 'daemon' },
		{ name: 'an ssh-ng URI with no destination', uri: 'ssh-ng://' }
	])('rejects $name', ({ uri }) => {
		let error: unknown;

		try {
			parseStoreUri(uri);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(InvalidStoreUriError);

		if (!(error instanceof InvalidStoreUriError)) {
			return;
		}

		expect(error.value).toBe(uri);
	});

	it.each([
		{
			name: 'a malformed query escape',
			uri: 'ssh-ng://example.test?remote-program=%ZZ',
			cause: URIError
		},
		{
			name: 'a malformed public host key',
			uri: 'ssh-ng://example.test?base64-ssh-public-host-key=not-base64',
			cause: Error
		},
		{
			name: 'an invalid typed setting',
			uri: 'ssh-ng://example.test?compress=perhaps',
			cause: NixConfigSettingError
		}
	])('wraps $name', ({ uri, cause }) => {
		let error: unknown;

		try {
			parseStoreUri(uri);
		} catch (error_: unknown) {
			error = error_;
		}

		expect(error).toBeInstanceOf(InvalidStoreUriError);

		if (!(error instanceof InvalidStoreUriError)) {
			return;
		}

		expect(error.value).toBe(uri);
		expect(error.cause).toBeInstanceOf(cause);
	});
});
