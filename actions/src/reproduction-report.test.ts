import { buildReceiptSchema } from '@cupboard/protocol/build';
import { describe, expect, it } from 'vitest';

import {
	reproducedSubjects,
	reproductionReport
} from './reproduction-report.ts';

const app = '/nix/store/0123456789abcdfghijklmnpqrsvwxyz-app';
const remote = '/nix/store/3123456789abcdfghijklmnpqrsvwxyz-remote';
const hash = '11'.repeat(32);

const reproduced = {
	origin: 'built',
	storePath: app,
	narHash: hash,
	derivation: `${app}.drv`,
	buildStore: 'auto',
	verification: 'local',
	reproduced: true
};

describe('reproducedSubjects', () => {
	it.each([3, 4])(
		'uses only explicit runner-local reproduction subjects from V%s',
		(version) => {
			const receipt = buildReceiptSchema.parse({
				version,
				paths: [app, remote],
				subjects: [
					reproduced,
					{
						...reproduced,
						storePath: remote,
						derivation: `${remote}.drv`,
						machine: 'ssh://builder'
					}
				]
			});
			const subjects = reproducedSubjects(receipt);
			expect({ subjects, report: reproductionReport(subjects) }).toStrictEqual({
				subjects: [{ storePath: app, sha256: hash, derivation: `${app}.drv` }],
				report: {
					attributes: [
						{
							attribute: 'REPRODUCIBLE',
							conditions: { derivation: `${app}.drv` }
						}
					]
				}
			});
		}
	);

	it('does not fabricate reproduction subjects from compact V4 publication sets', () => {
		const receipt = buildReceiptSchema.parse({
			version: 4,
			paths: [],
			subjects: [],
			publicationSets: [
				{
					result: {
						storePath: app,
						narHash: `sha256:${'1'.repeat(52)}`,
						generation: 0,
						cache: { kind: 'default' },
						cacheGeneration: 1
					},
					digest: 'a'.repeat(64),
					memberCount: 100_000,
					origin: 'build-selection',
					materialisation: 'complete'
				}
			]
		});
		expect(reproducedSubjects(receipt)).toStrictEqual([]);
	});

	it('keeps legacy V2 subjects out of reproduction reports', () => {
		const receipt = buildReceiptSchema.parse({
			version: 2,
			paths: [app],
			subjects: [
				{
					storePath: app,
					narHash: hash,
					derivation: `${app}.drv`,
					attempt: 1,
					attemptId: 'legacy'
				}
			]
		});
		expect(reproducedSubjects(receipt)).toStrictEqual([]);
	});
});
