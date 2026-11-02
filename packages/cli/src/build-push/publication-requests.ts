import { createHash, randomUUID } from 'node:crypto';
import { mkdir, open, readdir, readFile, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';

import { getLogger } from '@cupboard/logger';
import {
	createPublicationRequestId,
	publicationRequestIdSchema
} from '@cupboard/protocol/publication-manifests';
import {
	initialPublicationCaptureCheckpoint,
	publicationCaptureBindingSchema,
	type PublicationCaptureCheckpoint,
	publicationCaptureCheckpointSchema,
	publicationCaptureCheckpointUpdateSchema,
	type PublicationWorkflowExecutionContext,
	type PublicationWorkflowRequest,
	publicationWorkflowRequestSchema
} from '@cupboard/protocol/publication-workflow';
import { z } from 'zod';

import { PublicationRecoveryError } from './publication-recovery-error.ts';
import type { PublicationDestination } from './publication-sets.ts';

const logger = getLogger(['cupboard', 'publication', 'recovery']);

const fingerprintSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const legacyRequestsSchema = z.record(
	fingerprintSchema,
	publicationRequestIdSchema
);
const journalV2Schema = z.strictObject({
	version: z.literal(2),
	invocation: fingerprintSchema.optional(),
	requests: legacyRequestsSchema,
	snapshots: z.record(z.string(), z.unknown()),
	intents: z.record(z.string(), publicationWorkflowRequestSchema)
});
const journalSchema = journalV2Schema
	.extend({
		version: z.literal(3),
		captures: z.record(
			publicationRequestIdSchema,
			publicationCaptureCheckpointSchema
		)
	})
	.superRefine((journal, context) => {
		const ids = new Set<string>();
		for (const [key, intent] of Object.entries(journal.intents)) {
			if (intent.operation !== 'capture' && intent.operation !== 'ensure') {
				context.addIssue({
					code: 'custom',
					message: 'Invalid publication intent'
				});
				continue;
			}
			const target =
				intent.operation === 'capture'
					? intent.input.result
					: intent.input.source.result;
			if (
				key !== JSON.stringify([intent.operation, target.storePath]) ||
				intent.input.requestId === undefined
			) {
				context.addIssue({
					code: 'custom',
					message: 'Invalid publication intent identity'
				});
			}
			if (intent.operation !== 'capture') {
				continue;
			}
			const id = intent.input.requestId;
			const checkpoint = id === undefined ? undefined : journal.captures[id];
			if (id !== undefined) {
				ids.add(id);
			}
			if (
				checkpoint === undefined ||
				checkpoint.binding.invocation !== journal.invocation ||
				!isDeepStrictEqual(checkpoint.binding.input, intent.input)
			) {
				context.addIssue({
					code: 'custom',
					message: 'Missing or inconsistent expected capture checkpoint'
				});
			}
		}
		if (Object.keys(journal.captures).some((id) => !ids.has(id))) {
			context.addIssue({
				code: 'custom',
				message: 'Orphaned capture checkpoint'
			});
		}
	});
const requestsSchema = z.union([
	journalSchema,
	journalV2Schema,
	legacyRequestsSchema
]);
type Journal = z.output<typeof journalSchema>;
type PublicationIntent = Extract<
	PublicationWorkflowRequest,
	{ operation: 'capture' | 'ensure' }
>;
const completedRequestsSchema = z.strictObject({
	version: z.literal(1),
	files: z.record(z.string(), fingerprintSchema)
});

async function readJson(file: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(file, 'utf8'));
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return undefined;
		}
		if (error instanceof SyntaxError) {
			throw new PublicationRecoveryError('Corrupt publication recovery JSON', {
				cause: error
			});
		}
		throw error;
	}
}

function fingerprint(value: string): string {
	return createHash('sha256').update(value).digest('hex');
}

function parseRequests(value: unknown) {
	const parsed = requestsSchema.safeParse(value);
	if (!parsed.success) {
		throw new PublicationRecoveryError('Corrupt publication recovery state', {
			cause: parsed.error
		});
	}
	return parsed.data;
}

function emptyJournal(): Journal {
	return { version: 3, requests: {}, snapshots: {}, intents: {}, captures: {} };
}

function recoverJournal(persisted: ReturnType<typeof parseRequests>): Journal {
	if ('version' in persisted && persisted.version === 3) {
		return journalSchema.parse(persisted);
	}
	if (!('version' in persisted) || persisted.version !== 2) {
		if (Object.keys(persisted).length > 0) {
			throw new PublicationRecoveryError(
				'Publication recovery lacks immutable invocation inputs'
			);
		}
		return emptyJournal();
	}
	const old = journalV2Schema.parse(persisted);
	// v2 writes an ID before its intent. Only complete ensure intents prove that
	// every allocated ID preceded ensure rather than an unrecorded capture.
	const ensureIds = new Map<string, string>();
	for (const intent of Object.values(old.intents)) {
		if (intent.operation !== 'ensure' || intent.input.requestId === undefined) {
			throw new PublicationRecoveryError(
				'Unfinished v2 capture recovery has no immutable member checkpoint'
			);
		}
		const { requestId, ...input } = intent.input;
		ensureIds.set(fingerprint(JSON.stringify(['ensure', input])), requestId);
	}
	if (!isDeepStrictEqual(old.requests, Object.fromEntries(ensureIds))) {
		throw new PublicationRecoveryError(
			'Ambiguous unfinished v2 publication recovery'
		);
	}
	return journalSchema.parse({ ...old, version: 3, captures: {} });
}

export function publicationRequestsCompletionFile(receiptFile: string): string {
	return `${receiptFile}.publication-requests.completed.json`;
}

async function completedRequests(file: string) {
	const json = await readJson(file);
	return completedRequestsSchema.parse(
		json === undefined ? { version: 1, files: {} } : json
	);
}

/**
Check every sidecar, including cohorts absent from a changed command. Validate
completed journals before allowing a new invocation, without migrating them.
*/
export async function assertPublicationRequestsRecovery(
	receiptFile: string,
	commandInvocationFingerprint?: string
): Promise<void> {
	const completed = await completedRequests(
		publicationRequestsCompletionFile(receiptFile)
	);
	const directory = path.dirname(receiptFile);
	let names: string[];
	try {
		names = await readdir(directory);
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
			return;
		}
		throw error;
	}
	const basename = path.basename(receiptFile);
	const prefix = `${basename}.cohort-`;
	const suffix = '.publication-requests.json';
	for (const name of names) {
		if (
			name !== `${basename}${suffix}` &&
			!(
				name.startsWith(prefix) &&
				name.endsWith(suffix) &&
				/^\d+$/u.test(name.slice(prefix.length, -suffix.length))
			)
		) {
			continue;
		}
		const file = path.join(directory, name);
		const json = await readJson(file);
		if (json === undefined) {
			continue;
		}
		const persisted = parseRequests(json);
		if (
			completed.files[path.resolve(file)] ===
			fingerprint(JSON.stringify(persisted))
		) {
			continue;
		}
		if (commandInvocationFingerprint === undefined) {
			throw new PublicationRecoveryError(
				'Cannot bypass unfinished publication recovery'
			);
		}
		const journal = recoverJournal(persisted);
		if (
			journal.snapshots['command-invocation'] !== commandInvocationFingerprint
		) {
			throw new PublicationRecoveryError(
				'Publication recovery belongs to a different invocation'
			);
		}
	}
}

/**
An atomic mkdir excludes other cooperating journal writers across instances and
processes. Never guess that an existing lock is stale after a crash.
*/
async function exclusively<T>(
	file: string | undefined,
	work: () => Promise<T>
): Promise<T> {
	if (file === undefined) {
		return work();
	}
	const lock = `${file}.lock`;
	try {
		await mkdir(lock, { mode: 0o700 });
	} catch (error) {
		if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
			throw new PublicationRecoveryError(
				`Publication journal is already owned (${lock}); verify no writer is running before removing only its lock`,
				{ cause: error }
			);
		}
		throw error;
	}
	let outcome:
		{ kind: 'success'; value: T } | { kind: 'failure'; error: unknown };
	try {
		outcome = { kind: 'success', value: await work() };
	} catch (error) {
		outcome = { kind: 'failure', error };
	}
	try {
		await rm(lock, { recursive: true });
	} catch (error) {
		if (outcome.kind === 'success') {
			throw new PublicationRecoveryError(
				`Could not release publication journal ownership (${lock}); verify no writer is running before removing only its lock`,
				{ cause: error }
			);
		}
		logger.warn(
			'Publication journal ownership release failed; preserve {lock} and verify the original writer is inactive before removing only that lock',
			{ lock, error }
		);
	}
	if (outcome.kind === 'failure') {
		throw outcome.error;
	}
	return outcome.value;
}

/**
Replay data is not authority. Whole-command completion alone retires it.
*/
export async function publicationRequests(
	receiptFile: string | undefined,
	requestsFile?: string,
	completionFile = receiptFile === undefined
		? undefined
		: publicationRequestsCompletionFile(receiptFile),
	invocation?: string,
	commandInvocationFingerprint?: string
) {
	const file =
		requestsFile ??
		(receiptFile === undefined
			? undefined
			: `${receiptFile}.publication-requests.json`);
	const identity =
		invocation === undefined ? undefined : fingerprint(invocation);
	let journal = emptyJournal();
	let hasExpectedFile = false;
	const persist = async (next: Journal) => {
		next = journalSchema.parse(next);
		if (file !== undefined) {
			// A failed directory fsync may follow a successful rename. Future calls
			// must reload the actual outcome, never reuse a stale in-memory copy.
			hasExpectedFile = true;
			await writePublicationFile(file, `${JSON.stringify(next)}\n`);
		}
		journal = next;
	};
	const validateIdentity = (current: Journal) => {
		if (identity !== undefined && current.invocation !== identity) {
			throw new PublicationRecoveryError(
				'Publication recovery belongs to a different invocation'
			);
		}
	};
	await exclusively(file, async () => {
		const completed =
			completionFile === undefined
				? undefined
				: await completedRequests(completionFile);
		const json = file === undefined ? undefined : await readJson(file);
		if (json !== undefined) {
			const persisted = parseRequests(json);
			hasExpectedFile = true;
			if (
				completed?.files[path.resolve(file ?? '')] !==
				fingerprint(JSON.stringify(persisted))
			) {
				journal = recoverJournal(persisted);
			}
		}
		if (identity !== undefined) {
			if (journal.invocation === undefined) {
				journal = {
					...journal,
					invocation: identity,
					snapshots: {
						...journal.snapshots,
						...(commandInvocationFingerprint !== undefined && {
							'command-invocation': commandInvocationFingerprint
						})
					}
				};
			} else {
				validateIdentity(journal);
			}
		}
		// Also materialise a new empty owner: subsequent absence is not freshness.
		if (file !== undefined) {
			await persist(journal);
		}
	});
	const current = async (): Promise<Journal> => {
		if (file === undefined) {
			return journal;
		}
		const json = await readJson(file);
		if (json === undefined && hasExpectedFile) {
			throw new PublicationRecoveryError(
				'Missing expected publication journal'
			);
		}
		const loaded = journalSchema.safeParse(json);
		if (!loaded.success) {
			throw new PublicationRecoveryError(
				'Corrupt expected v3 publication journal',
				{ cause: loaded.error }
			);
		}
		validateIdentity(loaded.data);
		return loaded.data;
	};
	const update = <T>(work: (current: Journal) => Promise<T>): Promise<T> =>
		exclusively(file, async () => work(await current()));
	const requestId = async (key: string) =>
		update(async (current) => {
			const requestFingerprint = fingerprint(key);
			const existing = current.requests[requestFingerprint];
			if (existing !== undefined) {
				return existing;
			}
			const id = createPublicationRequestId();
			await persist({
				...current,
				requests: { ...current.requests, [requestFingerprint]: id }
			});
			return id;
		});
	return Object.assign(requestId, {
		async snapshot<T>(
			key: string,
			schema: z.ZodType<T>,
			create: () => Promise<T>
		): Promise<T> {
			return update(async (current) => {
				if (Object.hasOwn(current.snapshots, key)) {
					return schema.parse(current.snapshots[key]);
				}
				const value = schema.parse(await create());
				await persist({
					...current,
					snapshots: { ...current.snapshots, [key]: value }
				});
				return value;
			});
		},
		async intent<T extends PublicationIntent>(
			request: T,
			destination?: PublicationDestination
		): Promise<T> {
			return update(async (current) => {
				const target =
					request.operation === 'capture'
						? request.input.result
						: request.input.source.result;
				const key = JSON.stringify([request.operation, target.storePath]);
				const existing = current.intents[key];
				if (existing !== undefined) {
					if (
						!isDeepStrictEqual(
							{
								...existing,
								input: { ...existing.input, requestId: undefined }
							},
							{
								...publicationWorkflowRequestSchema.parse(request),
								input: { ...request.input, requestId: undefined }
							}
						)
					) {
						throw new PublicationRecoveryError(
							'Publication recovery input changed during the invocation'
						);
					}
					if (file !== undefined && existing.operation === 'capture') {
						const checkpoint =
							current.captures[
								publicationRequestIdSchema.parse(existing.input.requestId)
							];
						if (
							destination === undefined ||
							checkpoint === undefined ||
							!isDeepStrictEqual(
								{
									tenantUrl: checkpoint.binding.tenantUrl,
									cache: checkpoint.binding.cache
								},
								destination
							)
						) {
							throw new PublicationRecoveryError(
								'Publication recovery destination changed during the invocation'
							);
						}
					}
					return structuredClone(existing) as T;
				}
				const requestFingerprint = fingerprint(
					JSON.stringify([request.operation, request.input])
				);
				const id =
					current.requests[requestFingerprint] ?? createPublicationRequestId();
				const intent = publicationWorkflowRequestSchema.parse({
					...request,
					input: { ...request.input, requestId: id }
				});
				let checkpoint: PublicationCaptureCheckpoint | undefined;
				if (intent.operation === 'capture') {
					if (destination === undefined || current.invocation === undefined) {
						if (file !== undefined) {
							throw new PublicationRecoveryError(
								'Durable native capture requires its genuine invocation and canonical destination'
							);
						}
						// Genuinely no-receipt callers use the adapter's instance-local state.
						return structuredClone(intent) as T;
					}
					checkpoint = initialPublicationCaptureCheckpoint(
						publicationCaptureBindingSchema.parse({
							...destination,
							invocation: current.invocation,
							input: intent.input
						})
					);
				}
				await persist({
					...current,
					requests: { ...current.requests, [requestFingerprint]: id },
					intents: { ...current.intents, [key]: intent },
					captures: {
						...current.captures,
						...(checkpoint !== undefined && { [id]: checkpoint })
					}
				});
				return structuredClone(intent) as T;
			});
		},
		async captureContext(
			request: Extract<PublicationIntent, { operation: 'capture' }>
		): Promise<PublicationWorkflowExecutionContext | undefined> {
			if (file === undefined) {
				return undefined;
			}
			const id = publicationRequestIdSchema.parse(request.input.requestId);
			const load = async () => {
				const latest = await current();
				const checkpoint = latest.captures[id];
				if (
					checkpoint === undefined ||
					!isDeepStrictEqual(checkpoint.binding.input, request.input)
				) {
					throw new PublicationRecoveryError(
						'Missing or changed expected capture checkpoint'
					);
				}
				return publicationCaptureCheckpointSchema.parse(checkpoint);
			};
			const checkpoint = await exclusively(file, load);
			return {
				capture: {
					binding: checkpoint.binding,
					store: {
						load: () => exclusively(file, load),
						save: (expected, next) =>
							update(async (current) => {
								const actual = current.captures[id];
								if (!isDeepStrictEqual(actual, expected)) {
									throw new PublicationRecoveryError(
										'Stale capture checkpoint compare-and-swap'
									);
								}
								const validated =
									publicationCaptureCheckpointUpdateSchema.parse({
										previous: actual,
										next
									});
								await persist({
									...current,
									captures: { ...current.captures, [id]: validated.next }
								});
							})
					}
				}
			};
		}
	});
}
/**
One atomic completion record covers all sidecars; a successful cohort cannot
retire its own IDs while a later cohort, root update or receipt can still fail.
*/
export async function completePublicationRequests(
	receiptFile: string,
	files: readonly string[],
	signal?: AbortSignal
): Promise<void> {
	signal?.throwIfAborted();
	const file = publicationRequestsCompletionFile(receiptFile);
	const completed = await completedRequests(file);
	for (const requestsFile of files) {
		const json = await readJson(requestsFile);
		if (json === undefined) {
			continue;
		}
		const requests = parseRequests(json);
		completed.files[path.resolve(requestsFile)] = fingerprint(
			JSON.stringify(requests)
		);
	}
	// This rename is the completion boundary. Nothing fallible follows it.
	// A crash that loses the marker conservatively recovers the previous IDs.
	await replacePublicationFile(file, `${JSON.stringify(completed)}\n`, signal);
}

/**
Persists replay data before remote use, or a final receipt before completion.
*/
export async function writePublicationFile(
	file: string,
	contents: string
): Promise<void> {
	await replacePublicationFile(file, contents);
	const directory = await open(path.dirname(file), 'r');
	try {
		await directory.sync();
	} finally {
		await directory.close();
	}
}

async function replacePublicationFile(
	file: string,
	contents: string,
	signal?: AbortSignal
): Promise<void> {
	const temporary = `${file}.${randomUUID()}.tmp`;
	try {
		const handle = await open(temporary, 'wx', 0o600);
		try {
			await handle.writeFile(contents);
			await handle.sync();
		} finally {
			await handle.close();
		}
		signal?.throwIfAborted();
		await rename(temporary, file);
	} catch (error) {
		await rm(temporary, { force: true });
		throw error;
	}
}
