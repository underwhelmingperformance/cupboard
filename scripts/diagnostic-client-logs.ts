import { readdir } from 'node:fs/promises';
import path from 'node:path';

import { StatusCodes } from 'http-status-codes';
import { z } from 'zod';

import { readLogFile } from '../packages/logger/src/file.ts';

import type { TimeWindow } from './diagnose-push.ts';

const firstErrorStatus: number = StatusCodes.BAD_REQUEST;
const maximumFiles = 256;
const maximumRecords = 100_000;
const logFilename = /\.(?:jsonl|log)(?:\.(?:gz|zst))?(?:\.\d+)?$/u;

export interface ClientLogCollection {
	readonly files: number;
	readonly incompleteFiles: readonly string[];
	readonly unreadableFiles: readonly string[];
	readonly truncated: boolean;
	readonly records: readonly Record<string, unknown>[];
}

export type ClientCoverageCaveat =
	| 'server-telemetry'
	| 'untrusted-client-parent'
	| 'path-and-time'
	| 'client-log-coverage';

export interface ClientDiagnostics {
	readonly files: number;
	readonly records: number;
	readonly incompleteFiles: readonly string[];
	readonly unreadableFiles: readonly string[];
	readonly truncated: boolean;
	readonly attempts: number;
	readonly responses: number;
	readonly transportFailures: number;
	readonly bodyFailures: number;
	readonly recoveredOperations: number;
	readonly exhaustedOperations: number;
	readonly cancelledOperations: number;
	readonly droppedRecords: number;
	readonly transportFailureFraction: number | undefined;
	readonly refusalFraction: number | undefined;
	readonly correlation: Readonly<Record<Correlation, number>>;
	readonly caveats: readonly ClientCoverageCaveat[];
}

type Correlation =
	| 'requestId'
	| 'ray'
	| 'untrustedClientParent'
	| 'pathTimeCandidate'
	| 'unmatched';

interface ServerEvidence {
	readonly nativeTraceId: string | undefined;
	readonly nativeRequestId: string | undefined;
	readonly requestId: string | undefined;
	readonly ray: string | undefined;
	readonly clientTraceId: string | undefined;
	readonly clientSpanId: string | undefined;
	readonly method: string | undefined;
	readonly pathname: string | undefined;
	readonly timestamp: number | undefined;
}

type IdentifierMatch = 'requestId' | 'ray' | 'untrustedClientParent';

export type TelemetrySelection =
	| { readonly kind: 'time-window' }
	| {
			readonly kind: 'client-identifiers';
			readonly matchedBy: Readonly<Record<IdentifierMatch, number>>;
			readonly excludedEvents: number;
			readonly excludedTraces: number;
	  };

class ClientIdentifiers {
	private readonly requestIds = new Set<string>();
	private readonly rays = new Set<string>();
	private readonly parents = new Set<string>();

	constructor(records: readonly Record<string, unknown>[]) {
		for (const record of records) {
			const requestId = text(record.requestId);
			const cfRay = ray(record.cfRay);
			const traceId = text(record.trace_id);
			const spanId = text(record.span_id);

			if (requestId !== undefined) {
				this.requestIds.add(requestId);
			}

			if (cfRay !== undefined) {
				this.rays.add(cfRay);
			}

			if (traceId !== undefined && spanId !== undefined) {
				this.parents.add(`${traceId}/${spanId}`);
			}
		}
	}

	match(row: ServerEvidence): IdentifierMatch | undefined {
		if (row.requestId !== undefined && this.requestIds.has(row.requestId)) {
			return 'requestId';
		}

		if (row.ray !== undefined && this.rays.has(row.ray)) {
			return 'ray';
		}

		if (
			row.clientTraceId !== undefined &&
			row.clientSpanId !== undefined &&
			this.parents.has(`${row.clientTraceId}/${row.clientSpanId}`)
		) {
			return 'untrustedClientParent';
		}

		return undefined;
	}
}

const nativeIdentifierFields = [
	'nativeTraceId',
	'nativeRequestId',
	'requestId'
] as const;

function nativeIdentifiers(row: ServerEvidence): readonly string[] {
	return nativeIdentifierFields.flatMap((kind) => {
		const identifier = row[kind];

		return identifier === undefined ? [] : `${kind}:${identifier}`;
	});
}

class ServerTelemetryIndex {
	private readonly identifiers = new Map<string, number[]>();

	constructor(private readonly evidence: readonly ServerEvidence[]) {
		for (const [index, row] of evidence.entries()) {
			for (const identifier of nativeIdentifiers(row)) {
				const indices = this.identifiers.get(identifier) ?? [];
				indices.push(index);
				this.identifiers.set(identifier, indices);
			}
		}
	}

	select(anchors: ReadonlySet<number>): ReadonlySet<number> {
		const selected = new Set(anchors);
		const pending = [...anchors];
		const expanded = new Set<string>();

		while (pending.length > 0) {
			const index = pending.pop();
			const row = index === undefined ? undefined : this.evidence[index];

			if (row === undefined) {
				continue;
			}

			for (const identifier of nativeIdentifiers(row)) {
				if (expanded.has(identifier)) {
					continue;
				}

				expanded.add(identifier);

				const relatedIndices = this.identifiers.get(identifier) ?? [];

				for (const related of relatedIndices) {
					if (selected.has(related)) {
						continue;
					}

					selected.add(related);
					pending.push(related);
				}
			}
		}

		return selected;
	}
}

/**
Uses timestamps to bound retrieval, without using time as request identity.
*/
export function clientLogWindow(
	collection: ClientLogCollection
): TimeWindow | undefined {
	let from = Infinity;
	let to = -Infinity;

	for (const record of collection.records) {
		const timestamp = number(record.timestamp);

		if (timestamp === undefined) {
			continue;
		}

		from = Math.min(from, timestamp);
		to = Math.max(to, timestamp);
	}

	return Number.isFinite(from)
		? { from: from - 60_000, to: to + 60_000 }
		: undefined;
}

/**
Selects matched requests and their native traces; time and paths do not select records.
*/
export function selectClientTelemetry(
	collection: ClientLogCollection,
	events: readonly unknown[],
	traces: readonly unknown[]
): {
	readonly events: readonly unknown[];
	readonly traces: readonly unknown[];
	readonly selection: TelemetrySelection;
} {
	const client = new ClientIdentifiers(collection.records);
	const evidence = events.map((event) => serverEvidence(event));
	const anchors = new Set<number>();
	const matchedBy: Record<IdentifierMatch, number> = {
		requestId: 0,
		ray: 0,
		untrustedClientParent: 0
	};

	for (const [index, row] of evidence.entries()) {
		const match = client.match(row);

		if (match === undefined) {
			continue;
		}

		anchors.add(index);
		matchedBy[match] += 1;
	}

	const selected = new ServerTelemetryIndex(evidence).select(anchors);
	const selectedEvents = events.filter((_event, index) => selected.has(index));
	const nativeTraces = new Set(
		[...selected]
			.map((index) => evidence[index]?.nativeTraceId)
			.filter((traceId) => traceId !== undefined)
	);
	const selectedTraces = traces.filter((row) => {
		const traceId = text(field(row, 'traceId'));

		return traceId !== undefined && nativeTraces.has(traceId);
	});

	return {
		events: selectedEvents,
		traces: selectedTraces,
		selection: {
			kind: 'client-identifiers',
			matchedBy,
			excludedEvents: events.length - selectedEvents.length,
			excludedTraces: traces.length - selectedTraces.length
		}
	};
}

function field(value: unknown, key: string): unknown {
	if (typeof value !== 'object' || value === null) {
		return undefined;
	}

	const direct: unknown = Reflect.get(value, key);

	if (direct !== undefined) {
		return direct;
	}

	let nested: unknown = value;

	for (const segment of key.split('.')) {
		if (typeof nested !== 'object' || nested === null) {
			return undefined;
		}

		nested = Reflect.get(nested, segment);
	}

	return nested;
}

function text(value: unknown): string | undefined {
	return typeof value === 'string' ? value.slice(0, 256) : undefined;
}

function number(value: unknown): number | undefined {
	return typeof value === 'number' && Number.isFinite(value)
		? value
		: undefined;
}

function pathname(value: unknown): string | undefined {
	const raw = text(value);

	if (raw === undefined) {
		return undefined;
	}

	const url = URL.parse(raw, 'https://diagnostic.invalid');

	return url === null
		? undefined
		: url.pathname.replace(/^\/t\/[^/]+(?=\/|$)/u, '') || '/';
}

function ray(value: unknown): string | undefined {
	const raw = text(value);

	return raw?.replace(/^([0-9a-f]{16,32})-[a-z]+$/iu, '$1').toLowerCase();
}

/**
Reads ordinary LogTape files, including compressed and rotated files.
*/
export async function readClientLogs(
	directory: string
): Promise<ClientLogCollection> {
	const files: string[] = [];
	const records: Record<string, unknown>[] = [];
	const incompleteFiles: string[] = [];
	const unreadableFiles: string[] = [];
	let isTruncated = false;

	const visit = async (current: string, depth: number): Promise<void> => {
		const entries = await readdir(current, { withFileTypes: true });

		const sorted = entries.toSorted((left, right) =>
			left.name.localeCompare(right.name)
		);

		for (const entry of sorted) {
			if (files.length >= maximumFiles) {
				isTruncated = true;
				return;
			}

			const filename = path.join(current, entry.name);

			if (entry.isDirectory()) {
				if (depth < 3) {
					await visit(filename, depth + 1);
				} else {
					isTruncated = true;
				}

				continue;
			}

			if (entry.isFile() && logFilename.test(entry.name)) {
				files.push(filename);
			}
		}
	};
	await visit(directory, 0);

	for (const filename of files) {
		try {
			const read = await readLogFile(filename);

			if (read.incomplete) {
				incompleteFiles.push(path.relative(directory, filename));
			}

			const remaining = maximumRecords - records.length;
			for (const record of read.records.slice(0, remaining)) {
				records.push(record);
			}

			if (read.records.length > remaining) {
				isTruncated = true;
				break;
			}
		} catch {
			unreadableFiles.push(path.relative(directory, filename));
		}
	}

	return {
		files: files.length,
		records,
		incompleteFiles,
		unreadableFiles,
		truncated: isTruncated
	};
}

function serverEvidence(event: unknown): ServerEvidence {
	const source = field(event, 'source');

	return {
		nativeTraceId: text(
			field(event, '$metadata.traceId') ?? field(event, 'traceId')
		),
		nativeRequestId: text(field(event, '$metadata.requestId')),
		requestId: text(
			field(source, 'requestId') ?? field(source, 'cupboard.request_id')
		),
		ray: ray(
			field(source, 'cfRay') ??
				field(source, 'ray') ??
				field(event, '$metadata.requestId')
		),
		clientTraceId: text(
			field(source, 'clientTraceId') ??
				field(source, 'cupboard.upstream.trace_id')
		),
		clientSpanId: text(
			field(source, 'clientSpanId') ??
				field(source, 'cupboard.upstream.span_id')
		),
		method: text(
			field(source, 'method') ?? field(source, 'http.request.method')
		)?.toUpperCase(),
		pathname: pathname(field(source, 'path') ?? field(source, 'url.path')),
		timestamp: number(field(event, 'timestamp'))
	};
}

/**
Separates exact correlation from untrusted parent attributes and time candidates.
*/
export function analyseClientLogs(
	collection: ClientLogCollection,
	events: readonly unknown[]
): ClientDiagnostics {
	const evidence = events.map((event) => serverEvidence(event));
	const times = new Map<string, number[]>();

	for (const row of evidence) {
		if (
			row.method === undefined ||
			row.pathname === undefined ||
			row.timestamp === undefined
		) {
			continue;
		}

		const key = `${row.method} ${row.pathname}`;
		const stamps = times.get(key) ?? [];
		stamps.push(row.timestamp);
		times.set(key, stamps);
	}

	for (const stamps of times.values()) {
		stamps.sort((left, right) => left - right);
	}

	const requestIds = new Set(
		evidence.map((row) => row.requestId).filter((id) => id !== undefined)
	);
	const rays = new Set(
		evidence.map((row) => row.ray).filter((id) => id !== undefined)
	);
	const parents = new Set(
		evidence.flatMap((row) =>
			row.clientTraceId === undefined || row.clientSpanId === undefined
				? []
				: `${row.clientTraceId}/${row.clientSpanId}`
		)
	);
	const correlation: Record<Correlation, number> = {
		requestId: 0,
		ray: 0,
		untrustedClientParent: 0,
		pathTimeCandidate: 0,
		unmatched: 0
	};
	const count = (message: string): number =>
		collection.records.filter((record) => record.msg === message).length;
	const responses = collection.records.filter(
		(record) => record.msg === 'HTTP response headers received'
	);
	const attempts = count('HTTP attempt started');
	const transportFailures = count('HTTP attempt failed');
	const refusals = responses.filter(
		(record) => (number(record.status) ?? 0) >= firstErrorStatus
	).length;

	for (const record of collection.records) {
		if (
			![
				'HTTP response headers received',
				'HTTP attempt failed',
				'HTTP response body failed',
				'commit connection upgraded',
				'commit connection refused'
			].includes(text(record.msg) ?? '')
		) {
			continue;
		}

		const requestId = text(record.requestId);
		const cfRay = ray(record.cfRay);
		const traceId = text(record.trace_id);
		const spanId = text(record.span_id);
		let match: Correlation = 'unmatched';

		if (requestId !== undefined && requestIds.has(requestId)) {
			match = 'requestId';
		} else if (cfRay !== undefined && rays.has(cfRay)) {
			match = 'ray';
		} else if (
			traceId !== undefined &&
			spanId !== undefined &&
			parents.has(`${traceId}/${spanId}`)
		) {
			match = 'untrustedClientParent';
		} else {
			const stamp = number(record.timestamp);
			const method = text(record.method)?.toUpperCase();
			const target = pathname(record.url);

			if (
				stamp !== undefined &&
				method !== undefined &&
				target !== undefined &&
				hasNearbyTimestamp(times.get(`${method} ${target}`) ?? [], stamp)
			) {
				match = 'pathTimeCandidate';
			}
		}

		correlation[match] += 1;
	}

	return {
		files: collection.files,
		records: collection.records.length,
		incompleteFiles: collection.incompleteFiles,
		unreadableFiles: collection.unreadableFiles,
		truncated: collection.truncated,
		attempts,
		responses: responses.length,
		transportFailures,
		bodyFailures: count('HTTP response body failed'),
		recoveredOperations: collection.records.filter(
			(record) => record.disposition === 'recovered'
		).length,
		exhaustedOperations: collection.records.filter(
			(record) => record.disposition === 'exhausted'
		).length,
		cancelledOperations: collection.records.filter(
			(record) => record.disposition === 'cancelled'
		).length,
		droppedRecords: collection.records.reduce(
			(sum, record) => sum + (number(record.droppedRecords) ?? 0),
			0
		),
		transportFailureFraction:
			attempts === 0 ? undefined : transportFailures / attempts,
		refusalFraction:
			responses.length === 0 ? undefined : refusals / responses.length,
		correlation,
		caveats: [
			'server-telemetry',
			'untrusted-client-parent',
			'path-and-time',
			'client-log-coverage'
		]
	};
}

function hasNearbyTimestamp(stamps: readonly number[], stamp: number): boolean {
	let lower = 0;
	let upper = stamps.length;

	while (lower < upper) {
		const middle = Math.floor((lower + upper) / 2);
		const candidate = stamps[middle];

		if (candidate !== undefined && candidate < stamp - 5000) {
			lower = middle + 1;
		} else {
			upper = middle;
		}
	}

	const candidate = stamps[lower];

	return candidate !== undefined && candidate <= stamp + 5000;
}

const artifactSchema = z.object({
	id: z.number().int(),
	name: z.string(),
	expired: z.boolean()
});
const artifactPageSchema = z.object({ artifacts: z.array(artifactSchema) });

function parseArtifactPage(
	text: string
): z.infer<typeof artifactPageSchema> | undefined {
	try {
		const data: unknown = JSON.parse(text);
		const parsed = artifactPageSchema.safeParse(data);

		return parsed.success ? parsed.data : undefined;
	} catch {
		return undefined;
	}
}

export type ArtifactUnavailable =
	| { readonly kind: 'http'; readonly status: number }
	| { readonly kind: 'invalid-response' }
	| { readonly kind: 'request-failed' };

export interface LogArtifactDiscovery {
	readonly artifacts: readonly {
		readonly id: number;
		readonly name: string;
		readonly expired: boolean;
	}[];
	readonly incomplete: boolean;
	readonly unavailable?: ArtifactUnavailable;
}

/**
Lists diagnostic artifacts for a workflow run without inferring a job identity.
*/
export async function discoverLogArtifacts(
	run: {
		readonly owner: string;
		readonly repository: string;
		readonly runId: string;
	},
	options: { readonly token?: string; readonly fetcher?: typeof fetch } = {}
): Promise<LogArtifactDiscovery> {
	const artifacts: {
		readonly id: number;
		readonly name: string;
		readonly expired: boolean;
	}[] = [];

	try {
		for (let page = 1; page <= 10; page += 1) {
			const response = await (options.fetcher ?? fetch)(
				`https://api.github.com/repos/${encodeURIComponent(run.owner)}/${encodeURIComponent(run.repository)}/actions/runs/${run.runId}/artifacts?per_page=100&page=${String(page)}`,
				{
					headers: {
						accept: 'application/vnd.github+json',
						'user-agent': 'cupboard-diagnose-push',
						...(options.token !== undefined && {
							authorization: `Bearer ${options.token}`
						})
					}
				}
			);

			if (!response.ok) {
				return {
					artifacts,
					incomplete: true,
					unavailable: { kind: 'http', status: response.status }
				};
			}

			const parsed = parseArtifactPage(await response.text());

			if (parsed === undefined) {
				return {
					artifacts,
					incomplete: true,
					unavailable: { kind: 'invalid-response' }
				};
			}

			artifacts.push(
				...parsed.artifacts.filter((artifact) =>
					artifact.name.startsWith('cupboard-diagnostics-')
				)
			);

			if (parsed.artifacts.length < 100) {
				return { artifacts, incomplete: false };
			}
		}
	} catch {
		return {
			artifacts,
			incomplete: true,
			unavailable: { kind: 'request-failed' }
		};
	}

	return { artifacts, incomplete: true };
}
