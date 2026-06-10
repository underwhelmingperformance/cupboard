import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { InvalidCacheNameError } from '../errors.ts';

import { cacheSubstituterUrl, runConfig } from './config.ts';

function capturingReporter(infos: string[]): Reporter {
	return {
		phase(_label, body) {
			return Promise.resolve(
				body({
					fact() {
						return;
					}
				})
			);
		},
		result() {
			return;
		},
		warn() {
			return;
		},
		info(message) {
			infos.push(message);
		}
	};
}

describe('runConfig', () => {
	it('renders a nix.conf snippet for the given URL and public key', () => {
		const infos: string[] = [];

		runConfig(
			'https://cupboard.example.workers.dev',
			'cupboard-1:abc123',
			capturingReporter(infos)
		);

		expect(infos).toStrictEqual([
			[
				'substituters = https://cupboard.example.workers.dev',
				'trusted-public-keys = cupboard-1:abc123'
			].join('\n')
		]);
	});

	it('appends a netrc snippet when a read credential is configured', () => {
		const infos: string[] = [];

		runConfig(
			'https://cupboard.example.workers.dev',
			'cupboard-1:abc123',
			capturingReporter(infos),
			{ user: 'alice', password: 'correct-horse-battery-staple' }
		);

		expect(infos).toStrictEqual([
			[
				'substituters = https://cupboard.example.workers.dev',
				'trusted-public-keys = cupboard-1:abc123'
			].join('\n'),
			[
				'# Private cache: add this line to your Nix netrc-file ' +
					'(e.g. ~/.config/nix/netrc):',
				'machine cupboard.example.workers.dev login alice password correct-horse-battery-staple'
			].join('\n')
		]);
	});

	it('uses the URL hostname for the netrc machine', () => {
		const infos: string[] = [];

		runConfig(
			'http://localhost:1234',
			'cupboard-1:abc123',
			capturingReporter(infos),
			{ user: 'alice', password: 'correct-horse-battery-staple' }
		);

		expect(infos).toStrictEqual([
			[
				'substituters = http://localhost:1234',
				'trusted-public-keys = cupboard-1:abc123'
			].join('\n'),
			[
				'# Private cache: add this line to your Nix netrc-file ' +
					'(e.g. ~/.config/nix/netrc):',
				'machine localhost login alice password correct-horse-battery-staple'
			].join('\n')
		]);
	});
});

describe('cacheSubstituterUrl', () => {
	it.each([
		{
			name: 'the default cache returns the bare URL',
			cache: undefined,
			url: 'https://cupboard.example.workers.dev',
			expected: 'https://cupboard.example.workers.dev'
		},
		{
			name: 'a named cache appends the cache path to a bare host',
			cache: 'builds',
			url: 'https://cupboard.example.workers.dev',
			expected: 'https://cupboard.example.workers.dev/cache/builds'
		},
		{
			name: 'a named cache preserves a tenant path prefix',
			cache: 'builds',
			url: 'https://cupboard.example.workers.dev/t/acme',
			expected: 'https://cupboard.example.workers.dev/t/acme/cache/builds'
		}
	])('$name', ({ cache, expected, url }) => {
		expect(cacheSubstituterUrl(url, cache)).toBe(expected);
	});

	it('rejects an invalid cache name', () => {
		expect(() =>
			cacheSubstituterUrl('https://cupboard.example.workers.dev', 'Bad!')
		).toThrow(InvalidCacheNameError);
	});
});
