import { describe, expect, it } from 'vitest';

import { UploadNegotiationMismatchError } from '../errors.ts';

import {
	exactUploadDecisions,
	type NegotiatedPath,
	publishJustInTime
} from './negotiation.ts';

const first = { storePathHash: 'first', narHash: 'sha256:first' };
const second = { storePathHash: 'second', narHash: 'sha256:second' };

describe('exactUploadDecisions', () => {
	it('returns one exact decision per requested identity', () => {
		const decisions = [
			{ ...second, action: 'skip' as const },
			{ ...first, action: 'upload' as const }
		];

		expect(exactUploadDecisions([first, second], decisions)).toStrictEqual(
			decisions
		);
	});

	it.each([
		{
			name: 'an empty response',
			requested: [first],
			decisions: [],
			expected: { mismatch: 'missing', ...first }
		},
		{
			name: 'a partial response',
			requested: [first, second],
			decisions: [{ ...first, action: 'skip' }],
			expected: { mismatch: 'missing', ...second }
		},
		{
			name: 'a duplicate response',
			requested: [first],
			decisions: [
				{ ...first, action: 'skip' },
				{ ...first, action: 'skip' }
			],
			expected: { mismatch: 'duplicate', ...first }
		},
		{
			name: 'an unexpected response',
			requested: [first],
			decisions: [{ ...second, action: 'skip' }],
			expected: { mismatch: 'unexpected', ...second }
		}
	])('rejects $name', ({ requested, decisions, expected }) => {
		expect(() => exactUploadDecisions(requested, decisions)).toThrow(
			expect.objectContaining({
				name: UploadNegotiationMismatchError.name,
				...expected
			})
		);
	});
});

interface TestPath {
	readonly storePathHash: string;
	readonly narHash: string;
}

interface TestDecision extends TestPath {
	readonly action: 'skip' | 'upload';
}

function testPaths(count: number): readonly TestPath[] {
	return Array.from({ length: count }, (_, index) => ({
		storePathHash: `path-${String(index)}`,
		narHash: `sha256:${String(index)}`
	}));
}

function decided(
	paths: readonly TestPath[],
	action: (path: TestPath) => TestDecision['action']
): readonly TestDecision[] {
	return paths.map((path) => ({ ...path, action: action(path) }));
}

function itemName(item: NegotiatedPath<TestPath, TestDecision>): string {
	return item.kind === 'decided'
		? `${item.path.storePathHash}:${item.decision.action}:${String(item.hasUploadGraceFacts)}`
		: `${item.path.storePathHash}:refused`;
}

describe('publishJustInTime', () => {
	it.each([
		{
			name: 'starts at the concurrency',
			count: 3,
			concurrency: 3,
			maxGroupPaths: undefined,
			uploads: new Set<string>(),
			sizes: [3]
		},
		{
			name: 'widens each group as the upload share falls',
			count: 20,
			concurrency: 1,
			maxGroupPaths: undefined,
			uploads: new Set(['path-0']),
			sizes: [1, 1, 2, 4, 8, 4]
		},
		{
			name: 'widens while every decision so far is a skip',
			count: 10,
			concurrency: 1,
			maxGroupPaths: undefined,
			uploads: new Set<string>(),
			sizes: [1, 2, 4, 3]
		},
		{
			name: 'keeps groups at the number of free upload workers while every decision is an upload',
			count: 3,
			concurrency: 1,
			maxGroupPaths: undefined,
			uploads: new Set(testPaths(3).map((path) => path.storePathHash)),
			sizes: [1, 1, 1]
		},
		{
			name: 'caps each group at the maximum',
			count: 10,
			concurrency: 1,
			maxGroupPaths: 3,
			uploads: new Set<string>(),
			sizes: [1, 2, 3, 3, 1]
		}
	])('$name', async ({ count, concurrency, maxGroupPaths, uploads, sizes }) => {
		const negotiated: number[] = [];

		await publishJustInTime(
			{
				paths: testPaths(count),
				concurrency,
				...(maxGroupPaths !== undefined && { maxGroupPaths }),
				negotiationOf: (path) => path,
				negotiate: (paths) => {
					negotiated.push(paths.length);

					return Promise.resolve({
						uploads: decided(paths, (path) =>
							uploads.has(path.storePathHash) ? 'upload' : 'skip'
						),
						hasUploadGraceFacts: true
					});
				}
			},
			() => Promise.resolve()
		);

		expect(negotiated).toStrictEqual(sizes);
	});

	it('keeps one negotiation in flight and negotiates only when an upload worker is free', async () => {
		const events: string[] = [];
		const negotiations: PromiseWithResolvers<undefined>[] = [];
		const runs = new Map<string, PromiseWithResolvers<undefined>>();
		let inFlight = 0;
		let maxInFlight = 0;

		const published = publishJustInTime(
			{
				paths: testPaths(4),
				concurrency: 2,
				negotiationOf: (path) => path,
				negotiate: async (paths) => {
					inFlight += 1;
					maxInFlight = Math.max(maxInFlight, inFlight);
					events.push(
						`negotiate ${paths.map((path) => path.storePathHash).join(',')}`
					);
					const response = Promise.withResolvers<undefined>();
					negotiations.push(response);
					await response.promise;
					inFlight -= 1;

					return {
						uploads: decided(paths, () => 'upload'),
						hasUploadGraceFacts: true
					};
				}
			},
			async (item) => {
				const run = Promise.withResolvers<undefined>();
				runs.set(item.path.storePathHash, run);
				events.push(`start ${item.path.storePathHash}`);
				await run.promise;
			}
		);

		await flushMicrotasks();
		negotiations[0]?.resolve(undefined);
		await flushMicrotasks();
		const firstGroup = events.splice(0);

		runs.get('path-0')?.resolve(undefined);
		await flushMicrotasks();
		runs.get('path-1')?.resolve(undefined);
		await flushMicrotasks();
		const whileSecondNegotiates = events.splice(0);

		negotiations[1]?.resolve(undefined);
		await flushMicrotasks();
		const afterSecondGroup = events
			.splice(0)
			.toSorted((left, right) => left.localeCompare(right));

		negotiations[2]?.resolve(undefined);
		await flushMicrotasks();
		runs.get('path-2')?.resolve(undefined);
		runs.get('path-3')?.resolve(undefined);
		await published;

		expect({
			firstGroup,
			whileSecondNegotiates,
			afterSecondGroup,
			rest: events,
			maxInFlight
		}).toStrictEqual({
			firstGroup: ['negotiate path-0,path-1', 'start path-0', 'start path-1'],
			whileSecondNegotiates: ['negotiate path-2'],
			afterSecondGroup: ['negotiate path-3', 'start path-2'],
			rest: ['start path-3'],
			maxInFlight: 1
		});
	});

	it('refuses the paths of a failed negotiation and continues with later groups', async () => {
		const failure = new Error('negotiation failed');
		const items: string[] = [];
		let calls = 0;

		await publishJustInTime(
			{
				paths: testPaths(3),
				concurrency: 1,
				negotiationOf: (path) => path,
				negotiate: (paths) => {
					calls += 1;

					if (calls === 1) {
						return Promise.reject(failure);
					}

					return Promise.resolve({
						uploads: decided(paths, () => 'upload'),
						hasUploadGraceFacts: calls === 2
					});
				}
			},
			(item) => {
				items.push(itemName(item));

				return Promise.resolve();
			}
		);

		expect(items).toStrictEqual([
			'path-0:refused',
			'path-1:upload:true',
			'path-2:upload:false'
		]);
	});

	it('refuses the paths of a response whose decisions do not match the request', async () => {
		const refusals: unknown[] = [];

		await publishJustInTime(
			{
				paths: testPaths(1),
				concurrency: 1,
				negotiationOf: (path) => path,
				negotiate: () =>
					Promise.resolve({ uploads: [], hasUploadGraceFacts: true })
			},
			(item) => {
				refusals.push(item.kind === 'refused' ? item.error : undefined);

				return Promise.resolve();
			}
		);

		expect(refusals).toStrictEqual([
			expect.objectContaining({
				name: UploadNegotiationMismatchError.name,
				mismatch: 'missing',
				storePathHash: 'path-0'
			})
		]);
	});
});

async function flushMicrotasks(): Promise<void> {
	for (let iteration = 0; iteration < 10; iteration += 1) {
		await Promise.resolve();
	}
}
