import { describe, expect, it } from 'vitest';

import { NetrcControlCharacterError } from './errors.ts';
import { NixConfig, renderNetrc } from './nix-config.ts';

describe('NixConfig', () => {
	it('renders a nix.conf snippet', () => {
		const config = new NixConfig('https://cache.example', 'cupboard-1:key');
		expect(config.render()).toBe(
			[
				'extra-substituters = https://cache.example',
				'extra-trusted-public-keys = cupboard-1:key',
				''
			].join('\n')
		);
	});

	it('renders newline-separated rotation keys as one space-separated line', () => {
		const config = new NixConfig(
			'https://cache.example',
			'cupboard-1:one\ncupboard-2:two'
		);
		expect(config.render()).toBe(
			[
				'extra-substituters = https://cache.example',
				'extra-trusted-public-keys = cupboard-1:one cupboard-2:two',
				''
			].join('\n')
		);
	});

	it('renders several substituters on one line', () => {
		const config = new NixConfig(
			['https://cache.example', 'https://cache.example/reuse/nightly'],
			'cupboard-1:key'
		);
		expect(config.render()).toBe(
			[
				'extra-substituters = https://cache.example https://cache.example/reuse/nightly',
				'extra-trusted-public-keys = cupboard-1:key',
				''
			].join('\n')
		);
	});

	it('renders a netrc-file line when a path is given', () => {
		const config = new NixConfig('https://cache.example', 'cupboard-1:key', {
			netrcFile: '/tmp/cupboard-netrc'
		});
		expect(config.render()).toBe(
			[
				'extra-substituters = https://cache.example',
				'extra-trusted-public-keys = cupboard-1:key',
				'netrc-file = /tmp/cupboard-netrc',
				''
			].join('\n')
		);
	});
});

describe('renderNetrc', () => {
	it('renders a netrc line for the URL host, user and password', () => {
		expect(
			renderNetrc(
				new URL('https://cache.example.workers.dev'),
				'alice',
				'secret'
			)
		).toBe('machine cache.example.workers.dev login alice password secret\n');
	});

	it('drops the port from the machine host', () => {
		expect(
			renderNetrc(new URL('http://localhost:1234'), 'alice', 'secret')
		).toBe('machine localhost login alice password secret\n');
	});

	it('strips the brackets from an IPv6 machine host', () => {
		expect(renderNetrc(new URL('http://[::1]:8080'), 'alice', 'secret')).toBe(
			'machine ::1 login alice password secret\n'
		);
	});

	it('quotes and escapes a credential carrying whitespace or metacharacters', () => {
		expect(
			renderNetrc(
				new URL('https://cache.example'),
				'alice',
				String.raw`a b"c\d#e`
			)
		).toBe('machine cache.example login alice password "a b\\"c\\\\d#e"\n');
	});

	it.each([
		{ name: 'a NUL', value: 'a\u{0}b' },
		{ name: 'a tab', value: 'a\tb' },
		{ name: 'a newline', value: 'a\nb' },
		{ name: 'a DEL', value: 'a\u{7F}b' }
	])('refuses a credential carrying $name', ({ value }) => {
		expect(() =>
			renderNetrc(new URL('https://cache.example'), value, 'secret')
		).toThrow(NetrcControlCharacterError);
		expect(() =>
			renderNetrc(new URL('https://cache.example'), 'alice', value)
		).toThrow(NetrcControlCharacterError);
	});
});
