import type { Reporter } from '@cupboard/reporter';
import { describe, expect, it } from 'vitest';

import { InvalidCacheNameError } from '../errors.ts';

import { cacheSubstituterUrl, runConfig } from './config.ts';

interface CapturedOutput {
	readonly data: string[];
	readonly infos: string[];
}

function thrownBy(run: () => unknown): unknown {
	let thrown: unknown;

	try {
		run();
	} catch (error) {
		thrown = error;
	}

	return thrown;
}

function capturingReporter(captured: CapturedOutput): Reporter {
	return {
		phase: (_label, body) =>
			Promise.resolve(
				body({
					fact() {
						return;
					},
					warn() {
						return;
					}
				})
			),
		progress: (_label, _options, body) =>
			Promise.resolve(
				body({
					advance() {
						return;
					},
					fact() {
						return;
					},
					warn() {
						return;
					}
				})
			),
		steps: (_label, body) =>
			Promise.resolve(
				body({
					message() {
						return;
					},
					group: () => ({
						message() {
							return;
						},
						success() {
							return;
						},
						error() {
							return;
						}
					}),
					warn() {
						return;
					}
				})
			),
		result() {
			return;
		},
		data(text) {
			captured.data.push(text);
		},
		warn() {
			return;
		},
		info(message) {
			captured.infos.push(message);
		},
		success(message) {
			captured.infos.push(message);
		},
		step(message) {
			captured.infos.push(message);
		},
		error() {
			return;
		}
	};
}

const nixConfig = [
	'substituters = https://cupboard.example.workers.dev',
	'trusted-public-keys = cupboard-1:abc123'
].join('\n');

describe('runConfig', () => {
	it('writes a nix.conf snippet to the payload stream', () => {
		const captured: CapturedOutput = { data: [], infos: [] };

		runConfig(
			'https://cupboard.example.workers.dev',
			'cupboard-1:abc123',
			capturingReporter(captured)
		);

		expect(captured).toStrictEqual({ data: [nixConfig], infos: [] });
	});

	it('writes the nix.conf to the payload and the netrc as guidance', () => {
		const captured: CapturedOutput = { data: [], infos: [] };

		runConfig(
			'https://cupboard.example.workers.dev',
			'cupboard-1:abc123',
			capturingReporter(captured),
			{ user: 'alice', password: 'correct-horse-battery-staple' }
		);

		expect(captured).toStrictEqual({
			data: [nixConfig],
			infos: [
				[
					'# Private cache: add this line to your Nix netrc-file ' +
						'(e.g. ~/.config/nix/netrc):',
					'machine cupboard.example.workers.dev login alice password correct-horse-battery-staple'
				].join('\n')
			]
		});
	});

	it('uses the URL hostname for the netrc machine', () => {
		const captured: CapturedOutput = { data: [], infos: [] };

		runConfig(
			'http://localhost:1234',
			'cupboard-1:abc123',
			capturingReporter(captured),
			{ user: 'alice', password: 'correct-horse-battery-staple' }
		);

		expect(captured).toStrictEqual({
			data: [
				[
					'substituters = http://localhost:1234',
					'trusted-public-keys = cupboard-1:abc123'
				].join('\n')
			],
			infos: [
				[
					'# Private cache: add this line to your Nix netrc-file ' +
						'(e.g. ~/.config/nix/netrc):',
					'machine localhost login alice password correct-horse-battery-staple'
				].join('\n')
			]
		});
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
		const error = thrownBy(() =>
			cacheSubstituterUrl('https://cupboard.example.workers.dev', 'Bad!')
		);

		expect(error).toBeInstanceOf(InvalidCacheNameError);

		if (error instanceof InvalidCacheNameError) {
			expect({ name: error.name, cache: error.cache }).toStrictEqual({
				name: 'InvalidCacheNameError',
				cache: 'Bad!'
			});
		}
	});
});
