import { describe, expect, it } from 'vitest';

import type { Reporter } from '../reporter.ts';

import { runConfig } from './config.ts';

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
});
