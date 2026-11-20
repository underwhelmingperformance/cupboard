import { fakeCliUi } from '@cupboard/cli-ui/testing';
import { NixSha256Hash } from '@cupboard/nix-store/hash';
import { NarInfo } from '@cupboard/nix-store/narinfo';
import {
	cacheNameSchema,
	type CacheScope,
	rootNameSchema,
	type StorePathHash,
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { StorePath } from '@cupboard/nix-store/store-path';
import type {
	BuildInputsRecordEntry,
	BuildInputsRecordResult
} from '@cupboard/protocol/build-inputs';
import type { DependencyStatusEntry } from '@cupboard/protocol/dependency-status';
import {
	type DependencyGraphDocument,
	dependencyGraphDocumentVersion
} from '@cupboard/protocol/publish-plan';
import { reuseViewNameSchema } from '@cupboard/protocol/reuse-views';
import {
	uploadActionDecisionSchema,
	uploadConfirmPresentPathSchema,
	uploadNegotiateResponseSchema
} from '@cupboard/protocol/upload';
import { readUserInputSchema } from '@cupboard/shared/http';
import { ORPCError } from '@orpc/client';
import { describe, expect, it } from 'vitest';

import { buildInputsRecordAuthorizationDetails } from '../auth/attenuate.ts';
import { CupboardHttpError } from '../errors.ts';
import { type PushClient, runPush } from '../push/push.ts';

import {
	BuildInputsRecordRefusedError,
	dependencyPassAuthorizationDetails,
	type DependencyPassService,
	dependencyPassService,
	type DependencyPassServiceDependencies,
	isBuildInputsGrantRefusal,
	runPlanDependencies
} from './plan-dependencies.ts';

function storePath(name: string, index: number): StorePathString {
	return storePathSchema.parse(
		`/nix/store/${String(index).padStart(32, '0')}-${name}`
	);
}

const fetched = storePath('source', 1);
const compiler = storePath('compiler', 2);
const library = storePath('library', 3);
const tool = storePath('tool', 4);
const app = storePath('app', 5);
const manual = storePath('manual', 6);

// `app` needs `library` and `tool`, `library` needs the fetched source and
// `compiler`, and `manual` needs `tool`.
const document: DependencyGraphDocument = {
	version: dependencyGraphDocumentVersion,
	buildInputsVersion: 1,
	paths: [
		{ storePath: fetched, kind: 'dependency', buildInputs: [] },
		{ storePath: compiler, kind: 'dependency', buildInputs: [] },
		{
			storePath: library,
			kind: 'dependency',
			buildInputs: [StorePath.basename(fetched), StorePath.basename(compiler)]
		},
		{ storePath: tool, kind: 'dependency', buildInputs: [] },
		{
			storePath: app,
			kind: 'target',
			buildInputs: [StorePath.basename(library), StorePath.basename(tool)]
		},
		{
			storePath: manual,
			kind: 'target',
			buildInputs: [StorePath.basename(tool)]
		}
	]
};

type State =
	| { readonly state: 'absent'; readonly hasSource?: boolean }
	| { readonly state: 'in-flight' | 'present' }
	| { readonly state: 'recorded'; readonly version: number };

interface FakeBehaviour {
	readonly isUnsupported?: boolean;
	readonly uncopied?: readonly StorePathString[];
	readonly unreadable?: readonly StorePathString[];
	/**
	What happens to a row between the first status read and its attach: a
	collection deletes it, or a push creates it again with another state.
	*/
	readonly onAttach?: Partial<Record<StorePathString, State | 'deleted'>>;
	/**
	Rows that a collection deletes after the record page that confirms them.
	*/
	readonly deletedAfterRecord?: readonly StorePathString[];
	/**
	Rows that a newer client creates again, with another state, after the
	record page that confirms them.
	*/
	readonly recreatedAfterRecord?: Partial<Record<StorePathString, State>>;
	/**
	Paths that `attach` leaves out of both of its lists.
	*/
	readonly unreported?: readonly StorePathString[];
	readonly record?: 'refuse' | 'fail' | { readonly abortAfter: number };
}

interface FakeService extends DependencyPassService {
	readonly copies: StorePathString[][];
	readonly records: string[][];
	readonly attached: StorePathString[][];
	readonly statusRequests: number[];
}

// A cache that keeps the state of each path between runs, so a second run
// sees what the first one changed.
function fakeService(
	states: Map<StorePathString, State>,
	behaviour: FakeBehaviour = {},
	controller?: AbortController
): FakeService {
	const byHash = new Map(
		document.paths.map(({ storePath: path }) => [StorePath.hash(path), path])
	);
	const copies: StorePathString[][] = [];
	const records: string[][] = [];
	const attached: StorePathString[][] = [];
	const statusRequests: number[] = [];
	const statusOf = (storePathHash: StorePathHash): DependencyStatusEntry => {
		const path = byHash.get(storePathHash);
		const state = path === undefined ? undefined : states.get(path);

		switch (state?.state) {
			case undefined:
			case 'present': {
				return { storePathHash, state: 'present' };
			}
			case 'absent': {
				return {
					storePathHash,
					state: 'absent',
					...(state.hasSource === true && { source: { kind: 'default' } })
				};
			}
			case 'in-flight': {
				return { storePathHash, state: 'in-flight' };
			}
			case 'recorded': {
				return {
					storePathHash,
					state: 'recorded',
					buildInputsVersion: state.version
				};
			}
		}
	};

	const isReported = (path: StorePathString): boolean =>
		!(behaviour.unreported ?? []).includes(path);
	const isMissing = (path: StorePathString): boolean =>
		(behaviour.unreadable ?? []).includes(path) ||
		behaviour.onAttach?.[path] === 'deleted';

	return {
		copies,
		records,
		attached,
		statusRequests,
		statuses: (storePathHashes) => {
			statusRequests.push(storePathHashes.length);

			if (behaviour.isUnsupported === true) {
				return Promise.reject(
					new ORPCError('NOT_FOUND', {
						status: 404,
						data: { body: 'Not Found', headers: {} }
					})
				);
			}

			return Promise.resolve(
				storePathHashes.map((storePathHash) => statusOf(storePathHash))
			);
		},
		copy: (requested) => {
			const paths = requested.map(({ storePath: path }) => path);
			copies.push(paths);
			const copied = paths.filter(
				(path) => !(behaviour.uncopied ?? []).includes(path)
			);

			for (const path of copied) {
				states.set(path, { state: 'recorded', version: 1 });
			}

			return Promise.resolve(new Set(copied));
		},
		record: (entries: readonly BuildInputsRecordEntry[]) => {
			records.push(entries.map(({ storePath: path }) => path));

			if (behaviour.record === 'refuse') {
				return Promise.reject(new BuildInputsRecordRefusedError());
			}

			if (behaviour.record === 'fail') {
				return Promise.reject(new Error('the record request failed'));
			}

			const limit =
				behaviour.record === undefined
					? entries.length
					: behaviour.record.abortAfter;

			for (const entry of entries.slice(0, limit)) {
				const current = states.get(entry.storePath);

				// The server keeps the higher of the stored and given versions.
				states.set(entry.storePath, {
					state: 'recorded',
					version: Math.max(
						entry.buildInputsVersion,
						current?.state === 'recorded' ? current.version : 0
					)
				});
			}

			const deleted = behaviour.deletedAfterRecord ?? [];

			for (const path of deleted) {
				states.set(path, { state: 'absent' });
			}

			const recreated = Object.entries(behaviour.recreatedAfterRecord ?? {});

			for (const [path, state] of recreated) {
				if (state !== undefined) {
					states.set(storePathSchema.parse(path), state);
				}
			}

			if (limit < entries.length) {
				controller?.abort(new Error('the job was cancelled'));

				return Promise.reject(new Error('the job was cancelled'));
			}

			return Promise.resolve(
				entries.map((entry): BuildInputsRecordResult => ({
					storePath: entry.storePath,
					status: 'recorded'
				}))
			);
		},
		attach: (paths) => {
			attached.push([...paths]);

			for (const path of paths) {
				const change = behaviour.onAttach?.[path];

				if (change !== undefined) {
					states.set(path, change === 'deleted' ? { state: 'absent' } : change);
				}
			}

			return Promise.resolve({
				attached: paths.filter((path) => !isMissing(path) && isReported(path)),
				missing: paths.filter((path) => isMissing(path) && isReported(path))
			});
		}
	};
}

const allRecords = [fetched, compiler, library, tool, app, manual];
const unreachable = [fetched, compiler, library, tool];

function stateMap(
	states: Partial<Record<StorePathString, State>>
): Map<StorePathString, State> {
	return new Map(
		Object.entries(states).flatMap(([path, state]) =>
			state === undefined ? [] : [[storePathSchema.parse(path), state]]
		)
	);
}

describe('runPlanDependencies', () => {
	it.each([
		{
			name: 'a run with the grant and nothing blocked',
			states: { [fetched]: { state: 'absent', hasSource: true } },
			shouldRecord: true,
			behaviour: {},
			expected: {
				records: [allRecords],
				attached: [],
				record: 'recorded',
				recorded: 6,
				blocked: 0,
				warnings: 0
			}
		},
		{
			name: 'a run whose trust rule refuses the record grant',
			states: { [fetched]: { state: 'absent', hasSource: true } },
			shouldRecord: true,
			behaviour: { record: 'refuse' },
			expected: {
				records: [allRecords],
				attached: [[compiler, library, tool]],
				record: 'refused',
				recorded: 0,
				blocked: 0,
				warnings: 0
			}
		},
		{
			name: 'a pull-request run that never requests the grant',
			states: { [fetched]: { state: 'absent', hasSource: true } },
			shouldRecord: false,
			behaviour: {},
			expected: {
				records: [],
				attached: [[compiler, library, tool]],
				record: 'not-requested',
				recorded: 0,
				blocked: 0,
				warnings: 0
			}
		},
		{
			name: 'a run whose record request fails',
			states: { [fetched]: { state: 'absent', hasSource: true } },
			shouldRecord: true,
			behaviour: { record: 'fail' },
			expected: {
				records: [allRecords],
				attached: [[compiler, library, tool]],
				record: 'failed',
				recorded: 0,
				blocked: 0,
				warnings: 1
			}
		},
		{
			name: 'a run with an input in flight',
			states: {
				[fetched]: { state: 'absent', hasSource: true },
				[compiler]: { state: 'in-flight' }
			},
			shouldRecord: true,
			behaviour: {},
			expected: {
				records: [[fetched, tool, manual]],
				attached: [[library]],
				record: 'recorded',
				recorded: 3,
				blocked: 2,
				warnings: 0
			}
		},
		{
			name: 'a run whose copy leaves an input absent',
			states: { [fetched]: { state: 'absent', hasSource: true } },
			shouldRecord: true,
			behaviour: { uncopied: [fetched] },
			expected: {
				records: [[compiler, tool, manual]],
				attached: [[compiler, library]],
				record: 'recorded',
				recorded: 3,
				blocked: 2,
				warnings: 0
			}
		}
	] as const)(
		'records, copies and attaches as planned for $name',
		async ({ states, shouldRecord, behaviour, expected }) => {
			const service = fakeService(stateMap(states), behaviour);
			const { ui, captured } = fakeCliUi();

			const summary = await runPlanDependencies(
				{ document, shouldRecord },
				ui.reporter(),
				service
			);

			expect({
				copies: service.copies,
				records: service.records,
				attached: service.attached,
				summary,
				results: captured.results.map((result) => result.data),
				warnings: captured.warnings.length
			}).toStrictEqual({
				copies: [[fetched]],
				records: expected.records,
				attached: expected.attached,
				summary: {
					status: 'completed',
					record: expected.record,
					paths: 6,
					copied: behaviour.uncopied === undefined ? 1 : 0,
					recorded: expected.recorded,
					unchanged: 0,
					blocked: expected.blocked,
					attached: expected.attached.flat().length,
					unattached: 0,
					attachRounds: expected.attached.length
				},
				results: [summary],
				warnings: expected.warnings
			});
		}
	);

	it('warns about the paths to attach that the destination does not return, and counts them apart', async () => {
		const service = fakeService(stateMap({}), { unreadable: [fetched] });
		const { ui, captured } = fakeCliUi();

		const summary = await runPlanDependencies(
			{ document, shouldRecord: false },
			ui.reporter(),
			service
		);

		expect({
			attached: service.attached,
			summary,
			warnings: captured.warnings.length
		}).toStrictEqual({
			attached: [unreachable],
			summary: {
				status: 'completed',
				record: 'not-requested',
				paths: 6,
				copied: 0,
				recorded: 0,
				unchanged: 0,
				blocked: 0,
				attached: 3,
				unattached: 1,
				attachRounds: 1
			},
			warnings: 1
		});
	});

	it.each([
		{
			name: 'a collection deletes a recorded parent before the attach',
			change: 'deleted',
			summary: { attached: 3, unattached: 1 },
			warnings: 1
		},
		{
			name: 'a push creates a recorded parent again without build inputs',
			change: { state: 'present' },
			summary: { attached: 4, unattached: 0 },
			warnings: 0
		}
	] as const)(
		'attaches the inputs that the walk relied on when $name',
		async ({ change, summary, warnings }) => {
			const service = fakeService(
				stateMap({ [library]: { state: 'recorded', version: 1 } }),
				{ onAttach: { [library]: change } }
			);
			const { ui, captured } = fakeCliUi();

			const result = await runPlanDependencies(
				{ document, shouldRecord: false },
				ui.reporter(),
				service
			);

			expect({
				attached: service.attached,
				summary: result,
				warnings: captured.warnings.length
			}).toStrictEqual({
				attached: [
					[library, tool],
					[fetched, compiler]
				],
				summary: {
					status: 'completed',
					record: 'not-requested',
					paths: 6,
					copied: 0,
					recorded: 0,
					unchanged: 0,
					blocked: 0,
					...summary,
					attachRounds: 2
				},
				warnings
			});
		}
	);

	it.each([
		{
			name: 'rechecks the rows that only its record results keep, and attaches the inputs of one that a collection deleted',
			states: {},
			behaviour: { deletedAfterRecord: [library] },
			expected: {
				attached: [[fetched, compiler]],
				statusRequests: [6, 6, 3],
				summary: { recorded: 6, attached: 2, unattached: 0, attachRounds: 1 }
			}
		},
		{
			name: 'drops the confirmation of a row that a newer client created again at a higher version',
			states: {},
			behaviour: {
				recreatedAfterRecord: { [library]: { state: 'recorded', version: 2 } }
			},
			expected: {
				attached: [[fetched, compiler]],
				statusRequests: [6, 6, 4],
				summary: { recorded: 6, attached: 2, unattached: 0, attachRounds: 1 }
			}
		},
		{
			name: 'keeps the confirmation of a row that stays recorded at a higher version',
			states: { [library]: { state: 'recorded', version: 2 } },
			behaviour: {},
			expected: {
				attached: [],
				statusRequests: [6, 6],
				summary: { recorded: 6, attached: 0, unattached: 0, attachRounds: 0 }
			}
		},
		{
			name: 'reads no status again when every row was recorded at its version',
			states: Object.fromEntries(
				document.paths.map(({ storePath: path }) => [
					path,
					{ state: 'recorded', version: 1 } as const
				])
			),
			behaviour: {},
			expected: {
				attached: [],
				statusRequests: [6],
				summary: { recorded: 0, attached: 0, unattached: 0, attachRounds: 0 }
			}
		}
	] as const)('$name', async ({ states, behaviour, expected }) => {
		const service = fakeService(stateMap(states), behaviour);

		const summary = await runPlanDependencies(
			{ document, shouldRecord: true },
			fakeCliUi().ui.reporter(),
			service
		);

		expect({
			attached: service.attached,
			statusRequests: service.statusRequests,
			summary
		}).toStrictEqual({
			attached: expected.attached,
			statusRequests: expected.statusRequests,
			summary: {
				status: 'completed',
				record: 'recorded',
				paths: 6,
				copied: 0,
				unchanged: 0,
				blocked: 0,
				...expected.summary
			}
		});
	});

	it('attaches no copied path again, and makes no recheck when the copies are the only unkept paths', async () => {
		const recordedAtVersion = { state: 'recorded', version: 1 } as const;
		const service = fakeService(
			stateMap({
				[fetched]: { state: 'absent', hasSource: true },
				[compiler]: { state: 'absent' },
				[library]: { state: 'absent' },
				[tool]: recordedAtVersion,
				[app]: recordedAtVersion,
				[manual]: recordedAtVersion
			})
		);

		const summary = await runPlanDependencies(
			{ document, shouldRecord: false },
			fakeCliUi().ui.reporter(),
			service
		);

		expect({
			copies: service.copies,
			attached: service.attached,
			statusRequests: service.statusRequests,
			summary
		}).toStrictEqual({
			copies: [[fetched]],
			attached: [],
			statusRequests: [6],
			summary: {
				status: 'completed',
				record: 'not-requested',
				paths: 6,
				copied: 1,
				recorded: 0,
				unchanged: 0,
				blocked: 0,
				attached: 0,
				unattached: 0,
				attachRounds: 0
			}
		});
	});

	it('counts a path that attach leaves out of its answer as missing, and ends', async () => {
		const service = fakeService(stateMap({}), { unreported: [fetched] });

		const summary = await runPlanDependencies(
			{ document, shouldRecord: false },
			fakeCliUi().ui.reporter(),
			service
		);

		expect({ attached: service.attached, summary }).toStrictEqual({
			attached: [unreachable],
			summary: {
				status: 'completed',
				record: 'not-requested',
				paths: 6,
				copied: 0,
				recorded: 0,
				unchanged: 0,
				blocked: 0,
				attached: 3,
				unattached: 1,
				attachRounds: 1
			}
		});
	});

	it('reports a server without dependency status and changes nothing', async () => {
		const service = fakeService(new Map(), { isUnsupported: true });
		const { ui, captured } = fakeCliUi();

		const summary = await runPlanDependencies(
			{ document, shouldRecord: true },
			ui.reporter(),
			service
		);

		expect({
			summary,
			copies: service.copies,
			records: service.records,
			attached: service.attached,
			results: captured.results.map((result) => result.data)
		}).toStrictEqual({
			summary: { status: 'unsupported' },
			copies: [],
			records: [],
			attached: [],
			results: [{ status: 'unsupported' }]
		});
	});

	it('completes the build inputs that a cancelled run left unrecorded', async () => {
		const states = new Map<StorePathString, State>();
		const cancelled = new AbortController();
		const first = fakeService(states, { record: { abortAfter: 2 } }, cancelled);

		let firstRun = 'resolved';

		try {
			await runPlanDependencies(
				{ document, shouldRecord: true, signal: cancelled.signal },
				fakeCliUi().ui.reporter(),
				first
			);
		} catch (error) {
			firstRun = error instanceof Error ? error.message : 'rejected';
		}

		const second = fakeService(states);
		const secondSummary = await runPlanDependencies(
			{ document, shouldRecord: true },
			fakeCliUi().ui.reporter(),
			second
		);

		expect({
			firstRun,
			firstRecords: first.records,
			firstAttached: first.attached,
			secondRecords: second.records,
			secondAttached: second.attached,
			secondRecorded:
				secondSummary.status === 'completed' ? secondSummary.recorded : 0,
			states: Object.fromEntries(states)
		}).toStrictEqual({
			firstRun: 'the job was cancelled',
			firstRecords: [[fetched, compiler, library, tool, app, manual]],
			firstAttached: [],
			secondRecords: [[library, tool, app, manual]],
			secondAttached: [],
			secondRecorded: 4,
			states: Object.fromEntries(
				document.paths.map(({ storePath: path }) => [
					path,
					{ state: 'recorded', version: 1 }
				])
			)
		});
	});
});

describe('dependencyPassAuthorizationDetails', () => {
	const cache: CacheScope = {
		kind: 'named',
		name: cacheNameSchema.parse('ci')
	};
	const runRoot = rootNameSchema.parse('github:acme/app/main/_cupboard-run/1');

	it.each([
		{ name: 'without a reference source', sourceReads: [], extra: [] },
		{
			name: 'with a private reuse view',
			sourceReads: [{ view: reuseViewNameSchema.parse('acme') }],
			extra: [
				{
					type: 'cupboard_view',
					actions: ['view:content-read'],
					view: 'acme'
				}
			]
		}
	] as const)(
		'requests upload and run-root authority $name',
		({ sourceReads, extra }) => {
			expect(
				dependencyPassAuthorizationDetails({ cache, runRoot, sourceReads })
			).toStrictEqual([
				{
					type: 'cupboard_cache',
					actions: ['upload:negotiate', 'upload:status', 'upload:commit'],
					cache
				},
				{
					type: 'cupboard_cache',
					actions: ['root:attach'],
					cache,
					root: runRoot
				},
				...extra
			]);
		}
	);
});

describe('isBuildInputsGrantRefusal', () => {
	it.each([
		{
			name: 'a refused token exchange',
			error: new CupboardHttpError(
				'POST',
				'/t/acme/oauth/token',
				400,
				JSON.stringify({ error: 'invalid_authorization_details' })
			),
			isRefusal: true
		},
		{
			name: 'another token exchange error',
			error: new CupboardHttpError(
				'POST',
				'/t/acme/oauth/token',
				400,
				JSON.stringify({ error: 'invalid_grant' })
			),
			isRefusal: false
		},
		{
			name: 'a server error',
			error: new CupboardHttpError('POST', '/t/acme/oauth/token', 503, ''),
			isRefusal: false
		}
	])('recognises $name', ({ error, isRefusal }) => {
		expect(isBuildInputsGrantRefusal(error)).toBe(isRefusal);
	});
});

function narinfoFor(path: StorePathString): string {
	const hash = NixSha256Hash.fromDigest(Buffer.alloc(32)).toString();

	return NarInfo.fromFields({
		storePath: path,
		url: 'nar/path.nar.zst',
		compression: 'zstd',
		narHash: hash,
		narSize: 20,
		fileHash: hash,
		fileSize: 10,
		references: [],
		sigs: []
	}).render();
}

describe('dependencyPassService', () => {
	const tenantUrl = new URL('https://cache.example.test/t/acme');
	const cache: CacheScope = {
		kind: 'named',
		name: cacheNameSchema.parse('ci')
	};
	const runRoot = {
		name: rootNameSchema.parse('github:acme/app/main/_cupboard-run/1'),
		retention: { kind: 'inherit' as const }
	};
	const view = new URL(`${tenantUrl.href}/reuse/prs`);
	const shared = new URL(`${tenantUrl.href}/cache/shared`);
	const publicCache = new URL(`${tenantUrl.href}/cache/public`);
	const sourceCredential = {
		user: readUserInputSchema.parse('view-reader'),
		password: 'view-secret'
	};
	const destinationCredential = {
		user: readUserInputSchema.parse('reader'),
		password: 'secret'
	};
	const buildInputs = {
		version: 1 as const,
		buildInputsVersion: 1,
		paths: { [library]: [StorePath.basename(fetched)] }
	};
	const named = (name: string): CacheScope => ({
		kind: 'named',
		name: cacheNameSchema.parse(name)
	});

	interface Recorded {
		readonly exchanges: unknown[];
		readonly lookups: unknown[];
		readonly pushClients: unknown[];
		readonly pushes: unknown[];
		readonly records: unknown[];
		readonly accessProbes: string[];
		readonly clientCalls: string[];
		readonly confirmRoots: unknown[];
	}

	// A push client whose destination already has `present` and whose commit
	// of `failing` fails, so `runPush` reports failures as it does against a
	// server. Every other path commits by reference without an upload.
	function fakePushClient(
		calls: string[],
		confirmRoots: unknown[],
		behaviour: {
			readonly present: readonly StorePathString[];
			readonly failing: readonly StorePathString[];
		}
	): PushClient {
		// As the real client does, a confirmation carries the root that the
		// negotiation before it bound.
		let attachRoot: unknown;
		const hashes = (paths: readonly StorePathString[]) =>
			new Set(paths.map((path) => StorePath.hash(path)));
		const present = hashes(behaviour.present);
		const failing = hashes(behaviour.failing);

		return {
			preview: () => Promise.reject(new Error('unexpected preview')),
			negotiate: (body) => {
				calls.push('negotiate');
				attachRoot = body.attachRoot;

				return Promise.resolve(
					uploadNegotiateResponseSchema.parse({
						uploads: body.paths.map((path) => ({
							action: 'skip',
							storePathHash: path.storePathHash,
							narHash: path.narHash
						}))
					})
				);
			},
			confirmPresent: (skips) => {
				calls.push('confirm-present');
				confirmRoots.push(attachRoot);

				return Promise.resolve(
					skips.map((skip) =>
						uploadConfirmPresentPathSchema.parse(
							present.has(skip.storePathHash)
								? {
										storePathHash: skip.storePathHash,
										status: 'confirmed',
										generation: 0,
										narHash: skip.narHash,
										grace: {}
									}
								: { storePathHash: skip.storePathHash, status: 'missing' }
						)
					)
				);
			},
			publicationFor: (decision) =>
				uploadActionDecisionSchema.parse({
					action: 'upload',
					storePathHash: decision.storePathHash,
					narHash: decision.narHash,
					uploadId: `publication-${decision.storePathHash}`,
					r2Key: `staging-v2/acme/push/${decision.storePathHash}.nar.zst`,
					expiresAt: '2099-01-01T00:00:00.000Z'
				}),
			uploadNar: () => {
				calls.push('upload-nar');

				return Promise.reject(new Error('unexpected NAR upload'));
			},
			commit: (target) => {
				calls.push('commit');

				if (failing.has(target.storePathHash)) {
					return Promise.reject(new Error('the commit refused reuse'));
				}

				return Promise.resolve({
					storePathHash: target.storePathHash,
					narHash: target.narHash,
					status: 'committed' as const,
					settled: Promise.resolve()
				});
			},
			setRoot: () => Promise.reject(new Error('unexpected root write')),
			applyRoots: () => Promise.reject(new Error('unexpected root write'))
		};
	}

	function service(
		behaviour: {
			readonly present?: readonly StorePathString[];
			readonly pushFailures?: readonly StorePathString[];
			readonly unreadable?: readonly StorePathString[];
			readonly isRecordRefused?: boolean;
			// Cache URLs whose `nix-cache-info` probe fails.
			readonly accessFailures?: readonly string[];
			// Source URLs whose metadata lookup fails.
			readonly lookupFailures?: readonly string[];
		} = {}
	): {
		readonly recorded: Recorded;
		readonly reporter: ReturnType<typeof fakeCliUi>;
		readonly create: () => Promise<DependencyPassService>;
	} {
		const recorded: Recorded = {
			exchanges: [],
			lookups: [],
			pushClients: [],
			pushes: [],
			records: [],
			accessProbes: [],
			clientCalls: [],
			confirmRoots: []
		};
		const reporter = fakeCliUi();
		const tokens = ['token-a', 'token-b'];
		const dependencies: DependencyPassServiceDependencies = {
			authenticate: (authorizationDetails) => {
				recorded.exchanges.push(authorizationDetails);
				const token = tokens.shift() ?? 'token';

				if (token === 'token-b' && behaviour.isRecordRefused === true) {
					return Promise.reject(
						new CupboardHttpError(
							'POST',
							'/t/acme/oauth/token',
							400,
							JSON.stringify({ error: 'invalid_authorization_details' })
						)
					);
				}

				return Promise.resolve({
					get: () => Promise.resolve(token),
					refresh: () => Promise.resolve(token)
				});
			},
			tenantClients: () => ({
				uploads: {
					dependencyStatus: {
						inDefaultCache: () => Promise.reject(new Error('unexpected')),
						inNamedCache: () => Promise.reject(new Error('unexpected'))
					}
				},
				buildInputs: {
					record: {
						inDefaultCache: () => Promise.reject(new Error('unexpected')),
						inNamedCache: (input: { entries: BuildInputsRecordEntry[] }) => {
							recorded.records.push(
								input.entries.map((entry) => entry.storePath)
							);

							return Promise.resolve({
								entries: input.entries.map((entry) => ({
									storePath: entry.storePath,
									status: 'recorded' as const
								}))
							});
						}
					}
				}
			}),
			pushClient: (_credential, documentToSend) => {
				recorded.pushClients.push(documentToSend);

				return fakePushClient(recorded.clientCalls, recorded.confirmRoots, {
					present: behaviour.present ?? [],
					failing: behaviour.pushFailures ?? []
				});
			},
			readReferences: (paths, options) => {
				recorded.lookups.push({
					paths,
					sources: options.sources.map((source) => ({
						url: source.url.href,
						...(source.credential !== undefined && {
							credential: source.credential
						})
					}))
				});

				if (
					(behaviour.lookupFailures ?? []).includes(
						options.sources[0]?.url.href ?? ''
					)
				) {
					return Promise.reject(
						new Error('the source changed its scope between pages')
					);
				}

				return Promise.resolve(
					paths
						.filter((path) => !(behaviour.unreadable ?? []).includes(path))
						.map((path) => ({
							storePath: path,
							source: options.sources[0]?.url.href ?? '',
							narinfo: narinfoFor(path),
							kind: 'intermediate' as const
						}))
				);
			},
			runPush: (publication, pushReporter, options) => {
				recorded.pushes.push({
					references: publication.referenceEntries.map((entry) => ({
						storePath: entry.storePath,
						source: entry.reference?.source.href
					})),
					retain: options.retain,
					runRoot: options.runRoot
				});

				return runPush(publication, pushReporter, options);
			},
			fetchAccess: (url) => {
				recorded.accessProbes.push(url.href);

				if ((behaviour.accessFailures ?? []).includes(url.href)) {
					return Promise.reject(
						new Error('nix-cache-info answered 503 after retries')
					);
				}

				return Promise.resolve(
					url.href === publicCache.href ? 'public' : 'private'
				);
			}
		};

		return {
			recorded,
			reporter,
			create: () =>
				dependencyPassService(
					{
						tenantUrl,
						cache,
						runRoot,
						referenceSource: view,
						readCaches: [shared],
						sourceCredential,
						destinationCredential,
						buildInputs,
						credentialKind: 'github-oidc',
						reporter: reporter.ui.reporter()
					},
					dependencies
				)
		};
	}

	const copies = [
		{ storePath: fetched, source: named('shared') },
		{ storePath: compiler, source: named('public') },
		{ storePath: library, source: named('member') }
	];

	it('copies each path from a source that can read it, with its build inputs and the run root', async () => {
		const { recorded, create } = service();
		const pass = await create();
		const copied = await pass.copy(copies);

		expect({ copied: [...copied], ...recorded }).toStrictEqual({
			copied: [fetched, compiler, library],
			accessProbes: [
				view.href,
				shared.href,
				publicCache.href,
				`${tenantUrl.href}/cache/member`
			],
			clientCalls: [
				'negotiate',
				'confirm-present',
				'commit',
				'commit',
				'commit'
			],
			confirmRoots: [runRoot],
			exchanges: [
				dependencyPassAuthorizationDetails({
					cache,
					runRoot: runRoot.name,
					sourceReads: [
						{ view: reuseViewNameSchema.parse('prs') },
						{ cache: named('shared') }
					]
				})
			],
			lookups: [
				{ paths: [fetched], sources: [{ url: shared.href }] },
				{ paths: [compiler], sources: [{ url: publicCache.href }] },
				{
					paths: [library],
					sources: [{ url: view.href, credential: sourceCredential }]
				}
			],
			pushClients: [buildInputs],
			pushes: [
				{
					references: [
						{ storePath: fetched, source: shared.href },
						{ storePath: compiler, source: publicCache.href },
						{ storePath: library, source: view.href }
					],
					retain: false,
					runRoot
				}
			],
			records: []
		});
	});

	it('returns only the paths that a failed copy committed, and warns about the rest', async () => {
		const { recorded, reporter, create } = service({
			pushFailures: [compiler]
		});
		const pass = await create();
		const copied = await pass.copy(copies);

		expect({
			copied: [...copied],
			pushes: recorded.pushes.length,
			uploads: recorded.clientCalls.filter((call) => call === 'upload-nar'),
			passWarnings: reporter.captured.warnings.filter((warning) =>
				warning.startsWith('cannot copy every dependency output')
			).length
		}).toStrictEqual({
			copied: [fetched, library],
			pushes: 1,
			uploads: [],
			passWarnings: 1
		});
	});

	it('probes the access of each source cache once', async () => {
		const { recorded, create } = service();
		const pass = await create();
		const probesBeforeCopy = recorded.accessProbes.length;

		await pass.copy([
			{ storePath: fetched, source: named('public') },
			{ storePath: compiler, source: named('member') },
			{ storePath: library, source: named('public') },
			{ storePath: tool, source: named('member') }
		]);

		expect(recorded.accessProbes.slice(probesBeforeCopy)).toStrictEqual([
			`${tenantUrl.href}/cache/public`,
			`${tenantUrl.href}/cache/member`
		]);
	});

	it('copies nothing from a source whose access probe fails, warns once and copies the rest', async () => {
		const member = `${tenantUrl.href}/cache/member`;
		const { recorded, reporter, create } = service({
			accessFailures: [member]
		});
		const pass = await create();
		const probesBeforeCopy = recorded.accessProbes.length;
		const copied = await pass.copy([
			{ storePath: fetched, source: named('member') },
			{ storePath: compiler, source: named('public') },
			{ storePath: library, source: named('member') }
		]);

		expect({
			copied: [...copied],
			probes: recorded.accessProbes.slice(probesBeforeCopy),
			sourceWarnings: reporter.captured.warnings.filter((warning) =>
				warning.startsWith('cannot read a dependency source')
			).length
		}).toStrictEqual({
			copied: [compiler],
			probes: [member, publicCache.href],
			sourceWarnings: 1
		});
	});

	it('copies the paths of the sources whose metadata it can read, and warns about the others', async () => {
		const { reporter, create } = service({ lookupFailures: [shared.href] });
		const pass = await create();
		const copied = await pass.copy(copies);

		expect({
			copied: [...copied],
			lookupWarnings: reporter.captured.warnings.filter((warning) =>
				warning.startsWith('cannot read dependency metadata')
			).length
		}).toStrictEqual({ copied: [compiler, library], lookupWarnings: 1 });
	});

	it('counts the paths of a failed attach lookup as missing', async () => {
		const { create } = service({
			present: [tool],
			lookupFailures: [`${tenantUrl.href}/cache/ci`]
		});
		const pass = await create();

		expect(await pass.attach([tool])).toStrictEqual({
			attached: [],
			missing: [tool]
		});
	});

	it('attaches present paths from the destination without build inputs or an upload', async () => {
		const { recorded, create } = service({ present: [tool] });
		const pass = await create();
		const attached = await pass.attach([tool]);

		expect({
			attached,
			lookups: recorded.lookups,
			pushClients: recorded.pushClients,
			pushes: recorded.pushes,
			clientCalls: recorded.clientCalls,
			confirmRoots: recorded.confirmRoots
		}).toStrictEqual({
			attached: { attached: [tool], missing: [] },
			clientCalls: ['negotiate', 'confirm-present'],
			confirmRoots: [{ name: runRoot.name, retention: { kind: 'inherit' } }],
			lookups: [
				{
					paths: [tool],
					sources: [
						{
							url: `${tenantUrl.href}/cache/ci`,
							credential: destinationCredential
						}
					]
				}
			],
			pushClients: [undefined],
			pushes: [
				{
					references: [
						{ storePath: tool, source: `${tenantUrl.href}/cache/ci` }
					],
					retain: false,
					runRoot
				}
			]
		});
	});

	it('counts the paths to attach that the destination does not return', async () => {
		const { recorded, create } = service({
			present: [tool, manual],
			unreadable: [manual]
		});
		const pass = await create();
		const attached = await pass.attach([tool, manual]);

		expect({
			attached,
			pushes: recorded.pushes.map((push) =>
				typeof push === 'object' && push !== null && 'references' in push
					? push.references
					: push
			)
		}).toStrictEqual({
			attached: { attached: [tool], missing: [manual] },
			pushes: [[{ storePath: tool, source: `${tenantUrl.href}/cache/ci` }]]
		});
	});

	it('counts the paths that an attach push cannot confirm, and finishes', async () => {
		const { create } = service({ present: [tool], pushFailures: [manual] });
		const pass = await create();

		expect(await pass.attach([tool, manual])).toStrictEqual({
			attached: [tool],
			missing: [manual]
		});
	});

	it('warns about the paths to copy that a source cannot supply', async () => {
		const { reporter, create } = service({ unreadable: [compiler] });
		const pass = await create();
		const copied = await pass.copy(copies);

		expect({
			copied: [...copied],
			passWarnings: reporter.captured.warnings.filter((warning) =>
				warning.startsWith('cannot read every dependency output to copy')
			).length
		}).toStrictEqual({ copied: [fetched, library], passWarnings: 1 });
	});

	it.each([
		{ name: 'records with', isRecordRefused: false },
		{ name: 'reports a refusal of', isRecordRefused: true }
	])(
		'$name a second exchange that asks only for build-inputs:record',
		async ({ isRecordRefused }) => {
			const { recorded, create } = service({ isRecordRefused });
			const entries = [
				{
					storePath: tool,
					buildInputs: [],
					buildInputsVersion: 1
				}
			];
			const pass = await create();
			let outcome: unknown;

			try {
				outcome = await pass.record(entries);
			} catch (error) {
				outcome =
					error instanceof BuildInputsRecordRefusedError ? 'refused' : error;
			}

			expect({
				outcome,
				exchanges: recorded.exchanges.slice(1),
				records: recorded.records
			}).toStrictEqual({
				outcome: isRecordRefused
					? 'refused'
					: [{ storePath: tool, status: 'recorded' }],
				exchanges: [buildInputsRecordAuthorizationDetails({ cache })],
				records: isRecordRefused ? [] : [[tool]]
			});
		}
	);
});
