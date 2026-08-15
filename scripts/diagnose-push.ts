import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { argv, env, exit } from 'node:process';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { type CliUi, createCliUi, resolveReporterMode } from '@cupboard/cli-ui';
import type { Reporter, ReporterMode, ResultRow } from '@cupboard/reporter';
import { CodedError, genericExitCode } from '@cupboard/shared/errors';
import Cloudflare from 'cloudflare';
import { Command, InvalidArgumentError } from 'commander';
import { z } from 'zod';

import {
	obtainAuthorizationCode,
	postForm
} from '../packages/cli/src/auth/oidc-login.ts';
import {
	cacheDirectory,
	readSecretFile,
	writeSecretFile
} from '../packages/cli/src/auth/secret-file.ts';

// The diagnostic talks to Cloudflare as a dedicated public OAuth client (the id
// lives in `cf_analytics_client_id` at the repo root), separate from the deploy
// client: it needs only Workers Observability, which the deploy grant does not
// carry. The loopback redirect ports below must be registered on that client as
// `http://localhost:<port>/oauth/callback`.
const authorizationEndpoint = 'https://dash.cloudflare.com/oauth2/auth';
const tokenEndpoint = 'https://dash.cloudflare.com/oauth2/token';

const loopback = {
	ports: [8377, 8378, 8379] as const,
	host: 'localhost',
	path: '/oauth/callback'
} as const;

// Scope ids on cupboard's OAuth clients use the dotted spelling (`d1.write`,
// `workers-scripts.write`). Observability supplies the telemetry; the account
// read lets the SDK list accounts so the id resolves without `--account`;
// `offline_access` returns a refresh token so repeat runs skip the browser.
const observabilityScope =
	'workers-observability.write account-settings.read offline_access';

const repoRoot = path.resolve(fileURLToPath(import.meta.url), '..', '..');

// Cloudflare caps a single telemetry page. The events view is walked by its
// row-id cursor; the traces view, which has none, steps the window's upper
// bound back to just before the oldest row seen.
const pageLimit = 1000;

// The window is cut into slices, each paged on its own and fetched concurrently:
// about `sliceTargetMinutes` per slice, capped at `maxSlices`, with
// `fetchConcurrency` queries in flight at once across both views.
const sliceTargetMinutes = 30;
const maxSlices = 48;
const fetchConcurrency = 8;

const slowestCount = 12;

// Activity separated by a gap this long is treated as a different job, so the
// auto-detected window covers the most recent push rather than older traffic.
const defaultSessionGapMs = 60 * 1000;
const defaultSearchMinutes = 120;

class DiagnoseError extends CodedError {
	constructor(message: string, options?: { readonly cause: unknown }) {
		super(message, options);
		this.name = 'DiagnoseError';
	}
}

/**
A log line a Worker emitted, normalised to the fields the report needs.
*/
export interface WorkerLog {
	readonly requestId: string | undefined;
	readonly timestamp: number;
	readonly message: string;
	readonly httpMethod: string | undefined;
	readonly rpcMethod: string | undefined;
	readonly path: string | undefined;
	readonly status: number | undefined;
	readonly rowsRead: number;
	readonly rowsWritten: number;
	/**
	The operation bucket this line rolls up into.
	*/
	readonly bucket: string;
}

/**
One distributed trace: a single invocation with its total duration.
*/
export interface TraceSummary {
	readonly traceId: string;
	readonly bucket: string;
	readonly durationMs: number;
	readonly spans: number;
	readonly startMs: number;
	readonly errored: boolean;
}

/**
One span: a unit of work inside a trace (a D1 query, an R2 op, ...).
*/
export interface SpanEvent {
	readonly traceId: string;
	readonly spanId: string | undefined;
	readonly parentSpanId: string | undefined;
	readonly name: string;
	readonly startMs: number;
	readonly endMs: number;
}

/**
 * A leaf span kind rolled up across an operation. `busyMs` is the wall time the
 * kind occupied: overlapping spans within a call are merged, so concurrent
 * subrequests (634 R2 HEADs at once) count once against the clock rather than
 * summing past the request's own duration.
 */
export interface SpanStat {
	readonly name: string;
	readonly count: number;
	readonly busyMs: number;
}

/**
Per-operation rollup: timing from traces, row cost from logs.
*/
export interface OperationStat {
	readonly bucket: string;
	readonly group: string;
	readonly traceCount: number;
	readonly totalMs: number;
	readonly p50Ms: number;
	readonly p95Ms: number;
	readonly maxMs: number;
	readonly logCount: number;
	readonly rowsRead: number;
	readonly rowsWritten: number;
	readonly errors: number;
	/**
	Total spans across this operation's traces, from the trace summaries.
	*/
	readonly spanCount: number;
	/**
	Wall time not inside any traced subrequest: idle, blocked, or compute.
	*/
	readonly unaccountedMs: number;
	/**
	The operation's span kinds, busiest first (from the span events).
	*/
	readonly spans: readonly SpanStat[];
}

/**
Every operation sharing a trigger kind, with the group's own totals.
*/
export interface OperationGroup {
	readonly group: string;
	readonly tracedServerMs: number;
	readonly traceCount: number;
	readonly operations: readonly OperationStat[];
}

export interface TimeWindow {
	readonly from: number;
	readonly to: number;
}

export interface Analysis {
	readonly worker: string;
	readonly window: TimeWindow;
	readonly windowSource: 'fixed' | 'session';
	readonly invocations: number;
	readonly tracedServerMs: number;
	readonly wallSpanMs: number;
	readonly tracingAvailable: boolean;
	readonly verdict: string;
	readonly groups: readonly OperationGroup[];
	readonly slowest: readonly TraceSummary[];
	readonly totals: {
		readonly rowsRead: number;
		readonly rowsWritten: number;
		readonly errors: number;
	};
}

const dynamicSegment = /^([0-9a-z]{20,}|[0-9a-f]{16,}|.*%3[Aa].*)/;

const traceArtifactMessage = /^[A-Z]+ https?:\/\//;

// Segments whose meaning comes from the segment before them. Tenant slugs, cache
// names, store-path names, hashes and ids are collapsed so distinct pushes of
// distinct paths roll up into one operation bucket.
function normaliseSegment(
	segment: string,
	previous: string | undefined
): string {
	if (segment === '') {
		return segment;
	}

	if (previous === 't') {
		return ':tenant';
	}

	if (previous === 'cache') {
		return ':cache';
	}

	if (previous === 'nar') {
		return ':name';
	}

	if (previous === 'roots') {
		return ':name';
	}

	if (previous === 'attestations') {
		return ':id';
	}

	if (previous === 'attestation-bundles') {
		return ':digest';
	}

	if (previous === 'uploads' && segment !== 'prepare' && segment !== 'status') {
		return ':id';
	}

	if (segment.endsWith('.narinfo')) {
		return ':hash.narinfo';
	}

	if (dynamicSegment.test(segment)) {
		return ':id';
	}

	return segment;
}

/**
 * Collapses a request path's dynamic segments to placeholders so that pushes of
 * different store paths to different tenants share one operation bucket. The
 * path is treated as already URL-encoded, so an encoded root name keeps its
 * slashes inside a single segment.
 */
export function normalisePath(rawPath: string): string {
	const withoutQuery = rawPath.split('?', 1)[0] ?? rawPath;
	const parts = withoutQuery.split('/');

	const normalised = parts.map((segment, index) =>
		normaliseSegment(segment, index > 0 ? parts[index - 1] : '')
	);

	const joined = normalised.join('/');

	return joined === '' ? '/' : joined;
}

function pathOfUrl(rawPathOrUrl: string): string {
	const scheme = rawPathOrUrl.indexOf('://');

	if (scheme === -1) {
		return rawPathOrUrl;
	}

	const afterHost = rawPathOrUrl.slice(scheme + 3).indexOf('/');

	return afterHost === -1 ? '/' : rawPathOrUrl.slice(scheme + 3 + afterHost);
}

function stripTenantPrefix(requestPath: string): string {
	if (!requestPath.startsWith('/t/')) {
		return requestPath;
	}

	const afterTenant = requestPath.slice(3).indexOf('/');

	return afterTenant === -1 ? '/' : requestPath.slice(3 + afterTenant);
}

/**
 * Reduces a request URL or path to the operation key that both layers share:
 * the worker's own logs record the inner Durable Object request (no host, no
 * `/t/<tenant>` prefix), while a trace records the outer request. Stripping the
 * scheme, host and tenant prefix lets a trace's timing join the log's row cost.
 */
export function canonicalPath(rawPathOrUrl: string): string {
	return normalisePath(stripTenantPrefix(pathOfUrl(rawPathOrUrl)));
}

/**
The operation bucket for a log line: HTTP route, RPC method, or message.
*/
export function bucketForLog(
	httpMethod: string | undefined,
	rpcMethod: string | undefined,
	requestPath: string | undefined,
	message: string
): string {
	if (requestPath !== undefined) {
		return `${httpMethod ?? '?'} ${canonicalPath(requestPath)}`;
	}

	if (rpcMethod !== undefined) {
		return `rpc ${rpcMethod}`;
	}

	return message;
}

/**
The operation bucket for a trace, parsed from its root transaction name.
*/
export function bucketForTrace(rootTransactionName: string): string {
	const firstSpace = rootTransactionName.indexOf(' ');

	if (firstSpace === -1) {
		return rootTransactionName;
	}

	const method = rootTransactionName.slice(0, firstSpace);
	const requestPath = rootTransactionName.slice(firstSpace + 1);

	return `${method} ${canonicalPath(requestPath)}`;
}

const httpMethods = new Set([
	'GET',
	'POST',
	'PUT',
	'DELETE',
	'HEAD',
	'PATCH',
	'OPTIONS'
]);

const triggerKinds = new Set(['rpc', 'queue', 'alarm', 'scheduled', 'cron']);

/**
 * The trigger that drove an operation, so the report can show one section per
 * kind: an HTTP fetch, a queue consumer, a Durable Object alarm, a cron, a
 * direct RPC entrypoint, or anything else a worker logged.
 */
export function triggerGroup(bucket: string): string {
	const first = bucket.split(' ', 1)[0] ?? bucket;

	if (httpMethods.has(first)) {
		return 'fetch';
	}

	if (triggerKinds.has(first)) {
		return first;
	}

	return 'other';
}

const logSourceSchema = z.object({
	message: z.string().optional(),
	method: z.string().optional(),
	path: z.string().optional(),
	status: z.number().optional(),
	rowsRead: z.number().optional(),
	rowsWritten: z.number().optional()
});

const structuredSource = z.record(z.string(), z.unknown());

const eventSchema = z.object({
	timestamp: z.number(),
	source: z.union([z.string(), structuredSource]).optional(),
	$metadata: z
		.object({
			requestId: z.string().optional(),
			trigger: z.string().optional()
		})
		.optional()
});

const traceSchema = z.object({
	traceId: z.string(),
	rootTransactionName: z.string().optional(),
	rootSpanName: z.string().optional(),
	traceDurationMs: z.number(),
	spans: z.number().optional(),
	traceStartMs: z.number(),
	errors: z.array(z.string()).optional()
});

const spanSchema = z.object({
	timestamp: z.number(),
	$metadata: z.object({
		type: z.string().optional(),
		traceId: z.string().optional(),
		spanId: z.string().optional(),
		parentSpanId: z.string().optional(),
		spanName: z.string().optional(),
		transactionName: z.string().optional(),
		startTime: z.number().optional(),
		endTime: z.number().optional()
	})
});

// An HTTP `request finished` log carries a path and status; an RPC `method
// finished` log carries only a method name. Both carry the SQLite row cost.
export function parseWorkerLog(event: unknown): WorkerLog | undefined {
	const parsed = eventSchema.safeParse(event);

	if (!parsed.success) {
		return undefined;
	}

	// With tracing on, the events view also returns span events; they carry no
	// structured `message`. Only an object source with a message is one of the
	// worker's own `console.log` lines, which is what the row analysis needs.
	if (typeof parsed.data.source !== 'object') {
		return undefined;
	}

	const fields = logSourceSchema.safeParse(parsed.data.source);

	if (!fields.success) {
		return undefined;
	}

	const data = fields.data;

	if (data.message === undefined || data.message.trim() === '') {
		return undefined;
	}

	// A trace root surfaces in the events stream as a "METHOD https://..."
	// message with no structured path; the traces view already represents it,
	// so it would only double up the operation buckets.
	if (data.path === undefined && traceArtifactMessage.test(data.message)) {
		return undefined;
	}

	const requestPath = data.path;
	const httpMethod = requestPath === undefined ? undefined : data.method;
	const rpcMethod = requestPath === undefined ? data.method : undefined;

	return {
		requestId: parsed.data.$metadata?.requestId,
		timestamp: parsed.data.timestamp,
		message: data.message,
		httpMethod,
		rpcMethod,
		path: requestPath,
		status: data.status,
		rowsRead: data.rowsRead ?? 0,
		rowsWritten: data.rowsWritten ?? 0,
		bucket: bucketForLog(httpMethod, rpcMethod, requestPath, data.message)
	};
}

export function parseTraceSummary(trace: unknown): TraceSummary | undefined {
	const parsed = traceSchema.safeParse(trace);

	if (!parsed.success) {
		return undefined;
	}

	const named = parsed.data.rootTransactionName ?? parsed.data.rootSpanName;
	const transaction = named === undefined || named === '' ? 'unknown' : named;

	return {
		traceId: parsed.data.traceId,
		bucket: bucketForTrace(transaction),
		durationMs: parsed.data.traceDurationMs,
		spans: parsed.data.spans ?? 0,
		startMs: parsed.data.traceStartMs,
		errored: (parsed.data.errors?.length ?? 0) > 0
	};
}

// The events view returns span events alongside logs. A span carries its trace,
// a name (the D1/R2/DO operation) and a start and end, so its self-time is the
// difference; spans without both ends contribute count but no duration.
export function parseSpanEvent(event: unknown): SpanEvent | undefined {
	const parsed = spanSchema.safeParse(event);

	if (!parsed.success || parsed.data.$metadata.type !== 'span') {
		return undefined;
	}

	const meta = parsed.data.$metadata;
	const name = meta.spanName ?? meta.transactionName;

	if (name === undefined || meta.traceId === undefined) {
		return undefined;
	}

	const startMs = meta.startTime ?? parsed.data.timestamp;
	const endMs = Math.max(startMs, meta.endTime ?? startMs);

	return {
		traceId: meta.traceId,
		spanId: meta.spanId,
		parentSpanId: meta.parentSpanId,
		name,
		startMs,
		endMs
	};
}

/**
 * The most recent run of activity: the window from the start of the trailing
 * cluster (everything not separated from the newest point by a gap longer than
 * `gapMs`) to the newest point. Returns undefined when there is no activity.
 */
export function detectSession(
	timestamps: readonly number[],
	gapMs: number
): TimeWindow | undefined {
	if (timestamps.length === 0) {
		return undefined;
	}

	const sorted = timestamps.toSorted((a, b) => a - b);
	const to = sorted.at(-1) ?? 0;
	let from = to;

	for (let index = sorted.length - 1; index > 0; index -= 1) {
		const current = sorted[index];
		const earlier = sorted[index - 1];

		if (current === undefined || earlier === undefined) {
			break;
		}

		if (current - earlier > gapMs) {
			break;
		}

		from = earlier;
	}

	return { from, to };
}

/**
 * Whether the timestamps collected so far already contain a gap wider than
 * `gapMs`. A view is walked newest-first, so once such a gap opens every row
 * still to come is older than it: the trailing session is fully bracketed and
 * the walk can stop without paging the rest of the search window.
 */
export function hasSessionBoundary(
	timestamps: readonly number[],
	gapMs: number
): boolean {
	if (timestamps.length < 2) {
		return false;
	}

	const sorted = timestamps.toSorted((a, b) => a - b);

	for (let index = 1; index < sorted.length; index += 1) {
		const gap = (sorted[index] ?? 0) - (sorted[index - 1] ?? 0);

		if (gap > gapMs) {
			return true;
		}
	}

	return false;
}

export function percentile(
	sortedAscending: readonly number[],
	p: number
): number {
	if (sortedAscending.length === 0) {
		return 0;
	}

	const rank = Math.min(
		sortedAscending.length - 1,
		Math.max(0, Math.ceil((p / 100) * sortedAscending.length) - 1)
	);

	return sortedAscending[rank] ?? 0;
}

interface Bucket {
	durations: number[];
	logCount: number;
	rowsRead: number;
	rowsWritten: number;
	errors: number;
	spanCount: number;
	unaccountedMs: number;
	spans: Map<string, { count: number; busyMs: number }>;
}

/**
 * The wall time covered by a set of intervals, overlaps counted once: the
 * intervals are sorted and merged, then their lengths summed. This is how
 * concurrent subrequests of one kind add up to time on the clock rather than to
 * their summed durations.
 */
export function mergeBusy(
	intervals: readonly (readonly [number, number])[]
): number {
	const sorted = intervals.toSorted((a, b) => a[0] - b[0]);
	const first = sorted[0];

	if (first === undefined) {
		return 0;
	}

	let total = 0;
	let [, currentEnd] = first;
	let currentStart = first[0];

	for (const [start, end] of sorted.slice(1)) {
		if (start > currentEnd) {
			total += currentEnd - currentStart;
			currentStart = start;
			currentEnd = end;
		} else if (end > currentEnd) {
			currentEnd = end;
		}
	}

	return total + (currentEnd - currentStart);
}

// A leaf span (no other span in the trace names it as parent) is an actual unit
// of work: a D1 query, an R2 op, a storage exec. The parent spans that only wrap
// them are left out of the breakdown so their time is not counted twice.
function leafSpanKeys(spans: readonly SpanEvent[]): Set<string> {
	const parents = new Set<string>();

	for (const span of spans) {
		if (span.parentSpanId !== undefined) {
			parents.add(`${span.traceId}:${span.parentSpanId}`);
		}
	}

	const leaves = new Set<string>();

	for (const span of spans) {
		const key = `${span.traceId}:${span.spanId ?? ''}`;

		if (span.spanId === undefined || !parents.has(key)) {
			leaves.add(key);
		}
	}

	return leaves;
}

function emptyBucket(): Bucket {
	return {
		durations: [],
		logCount: 0,
		rowsRead: 0,
		rowsWritten: 0,
		errors: 0,
		spanCount: 0,
		unaccountedMs: 0,
		spans: new Map()
	};
}

const topSpanKinds = 8;

export function analyse(
	worker: string,
	window: TimeWindow,
	windowSource: 'fixed' | 'session',
	logs: readonly WorkerLog[],
	traces: readonly TraceSummary[],
	spans: readonly SpanEvent[]
): Analysis {
	const buckets = new Map<string, Bucket>();

	const bucketFor = (key: string): Bucket => {
		const existing = buckets.get(key);

		if (existing !== undefined) {
			return existing;
		}

		const created = emptyBucket();
		buckets.set(key, created);

		return created;
	};

	for (const log of logs) {
		const bucket = bucketFor(log.bucket);
		bucket.logCount += 1;
		bucket.rowsRead += log.rowsRead;
		bucket.rowsWritten += log.rowsWritten;

		if (log.status !== undefined && log.status >= 500) {
			bucket.errors += 1;
		}
	}

	const bucketByTrace = new Map<string, string>();

	for (const trace of traces) {
		const bucket = bucketFor(trace.bucket);
		bucket.durations.push(trace.durationMs);
		bucket.spanCount += trace.spans;
		bucketByTrace.set(trace.traceId, trace.bucket);

		if (trace.errored) {
			bucket.errors += 1;
		}
	}

	// Leaf spans only, grouped by trace and kind so each kind's overlapping
	// intervals merge within a single call before its busy time is summed across
	// calls. A leaf with no usable interval still counts towards the fan-out.
	const leaves = leafSpanKeys(spans);
	const perTraceKind = new Map<
		string,
		{
			bucket: string;
			name: string;
			count: number;
			intervals: [number, number][];
		}
	>();
	const leafIntervalsByTrace = new Map<string, [number, number][]>();

	for (const span of spans) {
		const bucketKey = bucketByTrace.get(span.traceId);

		if (bucketKey === undefined) {
			continue;
		}

		if (!leaves.has(`${span.traceId}:${span.spanId ?? ''}`)) {
			continue;
		}

		const key = `${span.traceId} ${span.name}`;
		const group = perTraceKind.get(key) ?? {
			bucket: bucketKey,
			name: span.name,
			count: 0,
			intervals: []
		};
		group.count += 1;
		group.intervals.push([span.startMs, span.endMs]);
		perTraceKind.set(key, group);

		const traceIntervals = leafIntervalsByTrace.get(span.traceId) ?? [];
		traceIntervals.push([span.startMs, span.endMs]);
		leafIntervalsByTrace.set(span.traceId, traceIntervals);
	}

	for (const group of perTraceKind.values()) {
		const kinds = bucketFor(group.bucket).spans;
		const kind = kinds.get(group.name) ?? { count: 0, busyMs: 0 };
		kind.count += group.count;
		kind.busyMs += mergeBusy(group.intervals);
		kinds.set(group.name, kind);
	}

	// Wall time the call spent outside any traced subrequest: its duration minus
	// the union of all its leaf spans. This is the idle/blocked/compute time the
	// per-span breakdown cannot show, and often the largest part.
	for (const trace of traces) {
		const inSubrequests = mergeBusy(
			leafIntervalsByTrace.get(trace.traceId) ?? []
		);
		bucketFor(trace.bucket).unaccountedMs += Math.max(
			0,
			trace.durationMs - inSubrequests
		);
	}

	const operations: OperationStat[] = [...buckets]
		.map(([bucket, value]) => {
			const sorted = value.durations.toSorted((a, b) => a - b);
			const totalMs = sorted.reduce((sum, ms) => sum + ms, 0);

			return {
				bucket,
				group: triggerGroup(bucket),
				traceCount: sorted.length,
				totalMs,
				p50Ms: percentile(sorted, 50),
				p95Ms: percentile(sorted, 95),
				maxMs: sorted.at(-1) ?? 0,
				logCount: value.logCount,
				rowsRead: value.rowsRead,
				rowsWritten: value.rowsWritten,
				errors: value.errors,
				spanCount: value.spanCount,
				unaccountedMs: value.unaccountedMs,
				spans: [...value.spans]
					.map(([name, stat]) => ({ name, ...stat }))
					.toSorted((a, b) => b.busyMs - a.busyMs || b.count - a.count)
					.slice(0, topSpanKinds)
			};
		})
		.toSorted((a, b) => b.totalMs - a.totalMs || b.logCount - a.logCount);

	const tracedServerMs = traces.reduce((sum, t) => sum + t.durationMs, 0);

	const slowest = traces
		.toSorted((a, b) => b.durationMs - a.durationMs)
		.slice(0, slowestCount);

	const invocationIds = new Set(
		logs.map((log) => log.requestId).filter((id) => id !== undefined)
	);

	const groups = groupOperations(operations);

	return {
		worker,
		window,
		windowSource,
		invocations: Math.max(traces.length, invocationIds.size),
		tracedServerMs,
		wallSpanMs: window.to - window.from,
		tracingAvailable: traces.length > 0,
		verdict: buildVerdict(groups, traces.length > 0),
		groups,
		slowest,
		totals: {
			rowsRead: logs.reduce((sum, log) => sum + log.rowsRead, 0),
			rowsWritten: logs.reduce((sum, log) => sum + log.rowsWritten, 0),
			errors: operations.reduce((sum, op) => sum + op.errors, 0)
		}
	};
}

/**
Collects operations by trigger group, each group most server time first.
*/
export function groupOperations(
	operations: readonly OperationStat[]
): OperationGroup[] {
	const byGroup = new Map<string, OperationStat[]>();

	for (const operation of operations) {
		const existing = byGroup.get(operation.group);

		if (existing === undefined) {
			byGroup.set(operation.group, [operation]);
			continue;
		}

		existing.push(operation);
	}

	return [...byGroup]
		.map(([group, groupOps]) => ({
			group,
			tracedServerMs: groupOps.reduce((sum, op) => sum + op.totalMs, 0),
			traceCount: groupOps.reduce((sum, op) => sum + op.traceCount, 0),
			operations: groupOps.toSorted(
				(a, b) => b.totalMs - a.totalMs || b.logCount - a.logCount
			)
		}))
		.toSorted((a, b) => b.tracedServerMs - a.tracedServerMs);
}

function formatMs(ms: number): string {
	if (ms >= 1000) {
		return `${(ms / 1000).toFixed(1)}s`;
	}

	return `${String(Math.round(ms))}ms`;
}

function formatCount(count: number): string {
	if (count >= 1000) {
		return `${(count / 1000).toFixed(1)}k`;
	}

	return String(count);
}

// Where an operation's time went: the bigger of its idle/blocked/compute time
// and its busiest subrequest kind, so the headline points at the real cost.
function dominantCost(op: OperationStat): string {
	const topSpan = op.spans[0];

	if (topSpan === undefined || op.unaccountedMs >= topSpan.busyMs) {
		return `${formatMs(op.unaccountedMs)} not in subrequests (idle/blocked/compute)`;
	}

	return `${formatMs(topSpan.busyMs)} in ${topSpan.name} (${formatCount(topSpan.count)} calls)`;
}

/**
 * The one-line headline, focused on the push request path (the `fetch` group)
 * when there is one: its costliest operation, how much of the group's time it
 * takes, and whether that time is subrequests or idle/blocked/compute.
 */
export function buildVerdict(
	groups: readonly OperationGroup[],
	isTracingAvailable: boolean
): string {
	if (!isTracingAvailable) {
		const busiest = groups
			.flatMap((group) => group.operations)
			.toSorted((a, b) => b.logCount - a.logCount)[0];

		if (busiest === undefined) {
			return 'No Worker activity in the window.';
		}

		return `No traces in the window (tracing may not have reached this deploy); busiest by request count is ${busiest.bucket} (${formatCount(busiest.logCount)} calls, ${formatCount(busiest.rowsRead)} rows read).`;
	}

	const group =
		groups.find((g) => g.group === 'fetch' && g.tracedServerMs > 0) ??
		groups.find((g) => g.tracedServerMs > 0);
	const top = group?.operations.find((op) => op.totalMs > 0);

	if (group === undefined || top === undefined) {
		return 'Traces carried no duration.';
	}

	const share = Math.round((top.totalMs / group.tracedServerMs) * 100);
	const lead = group.group === 'fetch' ? 'Push path' : `${group.group} work`;

	return `${lead}: most time (${formatMs(top.totalMs)} over ${formatCount(top.traceCount)} calls, ${String(share)}% of ${group.group}) is ${top.bucket}, ${dominantCost(top)}.`;
}

/**
The result card: the window, the headline verdict and the run totals.
*/
export function summaryRows(analysis: Analysis): ResultRow[] {
	const from = new Date(analysis.window.from).toISOString();
	const to = new Date(analysis.window.to).toISOString();
	const concurrency =
		analysis.wallSpanMs > 0
			? (analysis.tracedServerMs / analysis.wallSpanMs).toFixed(1)
			: '0';

	return [
		{ label: 'Verdict', value: analysis.verdict },
		{
			label: 'Window',
			value: `${from} -> ${to} (${formatMs(analysis.wallSpanMs)}, ${analysis.windowSource})`
		},
		{ label: 'Invocations', value: formatCount(analysis.invocations) },
		{ label: 'Traced server time', value: formatMs(analysis.tracedServerMs) },
		{ label: 'Concurrency', value: `~${concurrency}x` },
		{
			label: 'Rows read/written',
			value: `${formatCount(analysis.totals.rowsRead)}/${formatCount(analysis.totals.rowsWritten)}`
		},
		{ label: 'Errors', value: String(analysis.totals.errors) }
	];
}

/**
 * One row per operation, most server time first, each followed by indented rows
 * for its span kinds so the per-request fan-out (D1 runs, DO storage execs, R2
 * ops) is visible beneath the operation it belongs to.
 */
export function operationRows(
	operations: readonly OperationStat[]
): ResultRow[] {
	return operations.flatMap((op) => {
		const perCall =
			op.traceCount > 0
				? Math.round(op.spanCount / op.traceCount)
				: op.spanCount;
		const spanSummary =
			op.spanCount > 0
				? ` · ${formatCount(op.spanCount)} spans (${formatCount(perCall)}/call)`
				: '';

		const head: ResultRow = {
			label: op.bucket,
			value: `${formatMs(op.totalMs)} · p95 ${formatMs(op.p95Ms)} · ${formatCount(op.traceCount || op.logCount)}×${spanSummary} · r/w ${formatCount(op.rowsRead)}/${formatCount(op.rowsWritten)}${op.errors > 0 ? ` · ${String(op.errors)} err` : ''}`
		};

		// The idle/blocked/compute time is one more contributor, ranked against
		// the span kinds by wall time so the dominant cost sits at the top.
		const costs = [
			...op.spans.map((span) => ({
				label: span.name,
				value: `${formatCount(span.count)}× · ${formatMs(span.busyMs)} busy`,
				weight: span.busyMs
			})),
			...(op.unaccountedMs > 0
				? [
						{
							label: 'unaccounted (idle/blocked/compute)',
							value: formatMs(op.unaccountedMs),
							weight: op.unaccountedMs
						}
					]
				: [])
		]
			.toSorted((a, b) => b.weight - a.weight)
			.map((cost) => ({ label: `  ↳ ${cost.label}`, value: cost.value }));

		return [head, ...costs];
	});
}

/**
The slowest individual invocations, longest first.
*/
export function slowestRows(analysis: Analysis): ResultRow[] {
	return analysis.slowest.map((trace) => ({
		label: formatMs(trace.durationMs),
		value: `${trace.bucket}${trace.errored ? ' (error)' : ''}`
	}));
}

interface Options {
	readonly worker: string;
	readonly searchMinutes: number;
	readonly sinceMinutes: number | undefined;
	readonly gapMs: number;
	readonly account: string | undefined;
	readonly mode: ReporterMode;
	readonly forceLogin: boolean;
}

function resolveMode(
	isJson: boolean,
	outputMode: string | undefined
): ReporterMode {
	if (isJson) {
		return 'json';
	}

	if (outputMode === 'terminal' || outputMode === 'json') {
		return resolveReporterMode(outputMode);
	}

	if (outputMode !== undefined) {
		throw new DiagnoseError('Output mode must be one of: terminal, json.');
	}

	return resolveReporterMode();
}

function positiveNumber(value: string): number {
	const parsed = Number(value);

	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new InvalidArgumentError('Expected a positive number.');
	}

	return parsed;
}

interface ProgramFlags {
	readonly worker: string;
	readonly search: number;
	readonly since?: number;
	readonly gap: number;
	readonly account?: string;
	readonly outputMode?: string;
	readonly json?: boolean;
	readonly login?: boolean;
}

function parseOptions(arguments_: readonly string[]): Options {
	const program = new Command()
		.name('diagnose-push')
		.description(
			'Explain where a slow cupboard push spent its time, from Cloudflare Workers telemetry.'
		)
		.option('--worker <name>', 'Worker script to query', 'cupboard-tenant')
		.option(
			'--search <minutes>',
			'how far back to look for activity',
			positiveNumber,
			defaultSearchMinutes
		)
		.option(
			'--since <minutes>',
			'use a fixed window instead of auto-detecting the most recent session',
			positiveNumber
		)
		.option(
			'--gap <seconds>',
			'activity gap that separates one session from the next',
			positiveNumber,
			defaultSessionGapMs / 1000
		)
		.option('--account <id>', 'Cloudflare account id (otherwise resolved)')
		.option('--output-mode <mode>', 'force the output mode: terminal or json')
		.option('--json', 'shorthand for --output-mode json')
		.option('--login', 'force a fresh browser login, ignoring the cached grant')
		.allowExcessArguments(false);

	program.parse(arguments_, { from: 'user' });

	const flags = program.opts<ProgramFlags>();

	return {
		worker: flags.worker,
		searchMinutes: flags.search,
		sinceMinutes: flags.since,
		gapMs: flags.gap * 1000,
		account: flags.account,
		mode: resolveMode(flags.json ?? false, flags.outputMode),
		forceLogin: flags.login ?? false
	};
}

const cachedGrantSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	expires_at: z.number().int()
});

const tokenResponseSchema = z.object({
	access_token: z.string().min(1),
	refresh_token: z.string().min(1).optional(),
	expires_in: z.number().int().positive().optional()
});

interface Grant {
	readonly accessToken: string;
	readonly refreshToken: string | undefined;
	readonly expiresAt: number;
}

function tokenCachePath(): string {
	return path.join(cacheDirectory(), 'diagnose-push-token.json');
}

async function readCachedGrant(): Promise<Grant | undefined> {
	const contents = await readSecretFile(tokenCachePath());

	if (contents === undefined) {
		return undefined;
	}

	let payload: unknown;

	try {
		payload = JSON.parse(contents);
	} catch {
		return undefined;
	}

	const parsed = cachedGrantSchema.safeParse(payload);

	if (!parsed.success) {
		return undefined;
	}

	return {
		accessToken: parsed.data.access_token,
		refreshToken: parsed.data.refresh_token,
		expiresAt: parsed.data.expires_at
	};
}

function isFresh(grant: Grant, now: number): boolean {
	return grant.expiresAt > now + 60_000;
}

async function loadClientId(): Promise<string> {
	const raw = await readFile(path.join(repoRoot, 'cf_analytics_client_id'), {
		encoding: 'utf8'
	});
	const clientId = raw.trim();

	if (clientId === '') {
		throw new DiagnoseError('cf_analytics_client_id is empty');
	}

	return clientId;
}

async function exchange(
	form: Readonly<Record<string, string>>,
	previous: Grant | undefined,
	now: number
): Promise<Grant> {
	const response = await fetch(tokenEndpoint, postForm(form));

	if (!response.ok) {
		throw new DiagnoseError(
			`Token request failed with HTTP ${String(response.status)}`
		);
	}

	const parsed = tokenResponseSchema.safeParse(await response.json());

	if (!parsed.success) {
		throw new DiagnoseError('Token response carried no access token', {
			cause: parsed.error
		});
	}

	const grant: Grant = {
		accessToken: parsed.data.access_token,
		// Cloudflare may rotate the refresh token, or omit it on a refresh; keep
		// the previous one when the response does not replace it.
		refreshToken: parsed.data.refresh_token ?? previous?.refreshToken,
		expiresAt: now + (parsed.data.expires_in ?? 3600) * 1000
	};

	await writeCachedGrant(grant);

	return grant;
}

async function login(clientId: string, ui: CliUi, now: number): Promise<Grant> {
	const obtained = await obtainAuthorizationCode({
		authorizationEndpoint,
		clientId,
		scope: observabilityScope,
		openBrowser: (url) => {
			ui.openBrowser(url);
		},
		loopback
	});

	return exchange(
		{
			grant_type: 'authorization_code',
			code: obtained.code,
			redirect_uri: obtained.redirectUri,
			client_id: clientId,
			code_verifier: obtained.codeVerifier
		},
		undefined,
		now
	);
}

// Returns undefined when the refresh is declined (a revoked or expired grant)
// so the caller falls back to an interactive login.
async function refresh(
	clientId: string,
	grant: Grant,
	now: number
): Promise<Grant | undefined> {
	if (grant.refreshToken === undefined) {
		return undefined;
	}

	try {
		return await exchange(
			{
				grant_type: 'refresh_token',
				refresh_token: grant.refreshToken,
				client_id: clientId
			},
			grant,
			now
		);
	} catch {
		return undefined;
	}
}

async function writeCachedGrant(grant: Grant): Promise<void> {
	const stored: z.infer<typeof cachedGrantSchema> = {
		access_token: grant.accessToken,
		...(grant.refreshToken !== undefined && {
			refresh_token: grant.refreshToken
		}),
		expires_at: grant.expiresAt
	};

	await writeSecretFile(tokenCachePath(), `${JSON.stringify(stored)}\n`);
}

async function authenticate(
	ui: CliUi,
	options: Options,
	now: number
): Promise<string> {
	const clientId = await loadClientId();
	const cached = options.forceLogin ? undefined : await readCachedGrant();

	if (cached !== undefined && isFresh(cached, now)) {
		return cached.accessToken;
	}

	if (cached?.refreshToken !== undefined) {
		const renewed = await refresh(clientId, cached, now);

		if (renewed !== undefined) {
			return renewed.accessToken;
		}
	}

	ui.info('Logging in to Cloudflare for Workers Observability...');

	const grant = await login(clientId, ui, now);

	return grant.accessToken;
}

async function resolveAccountId(
	client: Cloudflare,
	override: string | undefined
): Promise<string> {
	const fromEnv = override ?? env.CLOUDFLARE_ACCOUNT_ID;

	if (fromEnv !== undefined && fromEnv !== '') {
		return fromEnv;
	}

	const accounts: { readonly id: string; readonly name: string }[] = [];

	for await (const account of client.accounts.list()) {
		accounts.push({ id: account.id, name: account.name });
	}

	const sole = accounts[0];

	if (sole !== undefined && accounts.length === 1) {
		return sole.id;
	}

	const listed = accounts.map((a) => `  ${a.id}  ${a.name}`).join('\n');

	throw new DiagnoseError(
		`Pass --account <id>; available accounts:\n${listed}`
	);
}

function serviceFilter(worker: string): {
	readonly key: string;
	readonly operation: 'eq';
	readonly type: 'string';
	readonly value: string;
} {
	return {
		key: '$metadata.service',
		operation: 'eq',
		type: 'string',
		value: worker
	};
}

/**
Reports the number of rows in each page as it arrives.
*/
type PageProgress = (pageRows: number) => void;

/**
One page of a telemetry view, as the SDK's query returns it.
*/
export interface TelemetryPageResponse {
	readonly events?: { readonly events?: unknown[] | null } | null;
	readonly traces?: unknown[] | null;
}

/**
The telemetry query as the pager consumes it: just the page parameters.
*/
export type TelemetryQuery = (parameters: {
	readonly view: 'events' | 'traces';
	readonly limit: number;
	readonly timeframe: { readonly from: number; readonly to: number };
	readonly offset?: string;
	readonly offsetDirection?: 'next';
}) => Promise<TelemetryPageResponse>;

type Sleep = (ms: number) => Promise<void>;

const defaultSleep: Sleep = (ms) =>
	new Promise((resolve) => setTimeout(resolve, ms));

// How many attempts a page query gets, and the base of the jittered linear
// backoff between them.
const telemetryQueryAttempts = 5;
const telemetryRetryBaseDelayMs = 500;

// The smallest a page shrinks to under repeated truncation, and the run of
// clean pages that eases it back up; see {@link AdaptivePageLimit}.
export const minPageLimit = 25;
const relaxAfterCleanPages = 4;

// The telemetry endpoint intermittently answers a bare 401 for a valid token,
// and 429/5xx are ordinary transient refusals; all are worth a few retries
// before the run fails.
function isRetryableTelemetryStatus(status: number): boolean {
	return status === 401 || status === 429 || status >= 500;
}

function telemetryErrorStatus(error: unknown): number | undefined {
	if (!(error instanceof Cloudflare.APIError)) {
		return undefined;
	}

	const status: unknown = error.status;

	return typeof status === 'number' ? status : undefined;
}

// The telemetry endpoint caps a response body at about a megabyte and truncates
// past it, so a page of large rows (a burst of fault logs, each carrying a
// serialised error) arrives as an unterminated JSON body the SDK cannot parse.
// The failure is a plain parse error, not an API status, so it is told apart by
// its message.
function isTruncatedBodyError(error: unknown): boolean {
	return (
		error instanceof Error &&
		/invalid json response body|unterminated string|unexpected end of (json|input)/i.test(
			error.message
		)
	);
}

// The row count of a page, adapted to the response-body cap the telemetry
// endpoint truncates at. A truncated body means the rows overflowed the cap,
// not that the timeframe was wrong, so the same page refetched with fewer rows
// fits: the limit halves on each truncation, down to a floor. It eases back up
// after a run of clean pages so the sparse remainder of a window is not walked
// one tiny page at a time once a dense burst is behind it.
class AdaptivePageLimit {
	private limit = pageLimit;
	private cleanPages = 0;

	value(): number {
		return this.limit;
	}

	// Halve the page after a truncated body. Returns false once the floor is
	// reached, where a smaller page cannot help and the parse failure is real.
	shrink(): boolean {
		if (this.limit <= minPageLimit) {
			return false;
		}

		this.limit = Math.max(minPageLimit, Math.floor(this.limit / 2));
		this.cleanPages = 0;

		return true;
	}

	// A page parsed cleanly. After a short run of them, ease the limit back up.
	relax(): void {
		if (this.limit >= pageLimit) {
			return;
		}

		this.cleanPages += 1;

		if (this.cleanPages >= relaxAfterCleanPages) {
			this.limit = Math.min(pageLimit, this.limit * 2);
			this.cleanPages = 0;
		}
	}
}

async function queryPageWithRetry(
	query: TelemetryQuery,
	parameters: Omit<Parameters<TelemetryQuery>[0], 'limit'>,
	pageSize: AdaptivePageLimit,
	sleep: Sleep
): Promise<TelemetryPageResponse> {
	let attempt = 0;

	for (;;) {
		try {
			const response = await query({ ...parameters, limit: pageSize.value() });
			pageSize.relax();

			return response;
		} catch (error) {
			// A truncation retry refetches the same page smaller; it is not a
			// transient refusal, so it does not spend the retry budget.
			if (isTruncatedBodyError(error) && pageSize.shrink()) {
				continue;
			}

			attempt += 1;
			const status = telemetryErrorStatus(error);

			if (
				status === undefined ||
				attempt >= telemetryQueryAttempts ||
				!isRetryableTelemetryStatus(status)
			) {
				throw error;
			}

			await sleep(
				telemetryRetryBaseDelayMs * attempt +
					Math.random() * telemetryRetryBaseDelayMs
			);
		}
	}
}

function pageRowsOf(
	response: TelemetryPageResponse,
	view: 'events' | 'traces'
): unknown[] {
	return view === 'events'
		? (response.events?.events ?? [])
		: (response.traces ?? []);
}

// The smallest row id in a page, or undefined if no row carries one. The id
// (a ULID) sorts lexicographically, so the minimum is the page's true oldest
// row regardless of the order the view returns it in.
function smallestCursor(
	page: readonly unknown[],
	cursorOf: (row: unknown) => string | undefined
): string | undefined {
	let smallest: string | undefined;

	for (const row of page) {
		const id = cursorOf(row);

		if (id !== undefined && (smallest === undefined || id < smallest)) {
			smallest = id;
		}
	}

	return smallest;
}

// The oldest (smallest) timestamp in a page, or undefined if none carries one.
function oldestTimestamp(
	page: readonly unknown[],
	timestampOf: (row: unknown) => number | undefined
): number | undefined {
	let oldest: number | undefined;

	for (const row of page) {
		const at = timestampOf(row);

		if (at !== undefined && (oldest === undefined || at < oldest)) {
			oldest = at;
		}
	}

	return oldest;
}

// Pages a view with the API's cursor: within a fixed upper bound each page's
// smallest row id becomes the next page's offset, so the walk reaches every
// row, including bursts sharing one millisecond that a stepped timeframe
// cannot subdivide. Within a millisecond the view has no stable order, so the
// last row of a page is not its oldest; advancing by the smallest id keeps the
// offset moving strictly downwards.
//
// The cursor eventually refuses to page a dense burst any further, answering a
// full page whose smallest id is the offset it was already given. The walk
// then steps the upper bound below the oldest timestamp it has seen and drops
// the cursor: everything above that timestamp is already drained, so this
// resumes older rows and, because the bound strictly decreases, guarantees the
// walk terminates. Rows dedup by id across the whole walk. It ends on an empty
// page or once the bound falls below the window.
async function fetchByCursor(
	query: TelemetryQuery,
	view: 'events' | 'traces',
	window: TimeWindow,
	cursorOf: (row: unknown) => string | undefined,
	timestampOf: (row: unknown) => number | undefined,
	onPage: PageProgress,
	sleep: Sleep,
	stopAtGapMs: number | undefined
): Promise<unknown[]> {
	const rows: unknown[] = [];
	const seen = new Set<string>();
	const timestamps: number[] = [];
	const pageSize = new AdaptivePageLimit();
	let upper = window.to;
	let offset: string | undefined;

	for (;;) {
		const response = await queryPageWithRetry(
			query,
			{
				view,
				timeframe: { from: window.from, to: upper },
				...(offset !== undefined && {
					offset,
					offsetDirection: 'next' as const
				})
			},
			pageSize,
			sleep
		);

		const page = pageRowsOf(response, view);

		if (page.length === 0) {
			break;
		}

		const fresh = page.filter((row) => {
			const id = cursorOf(row);

			return id === undefined || !seen.has(id);
		});

		for (const row of fresh) {
			const id = cursorOf(row);

			if (id !== undefined) {
				seen.add(id);
			}
		}

		rows.push(...fresh);
		onPage(fresh.length);

		if (stopAtGapMs !== undefined) {
			for (const row of fresh) {
				const at = timestampOf(row);

				if (at !== undefined) {
					timestamps.push(at);
				}
			}

			if (hasSessionBoundary(timestamps, stopAtGapMs)) {
				break;
			}
		}

		const next = smallestCursor(page, cursorOf);

		if (next !== undefined && (offset === undefined || next < offset)) {
			offset = next;
			continue;
		}

		// The cursor cannot move any lower within this bound. Step the bound
		// below the oldest timestamp seen and start a fresh cursor beneath it;
		// everything at or above that timestamp is already collected.
		const oldest = oldestTimestamp(page, timestampOf);

		if (oldest === undefined || oldest <= window.from) {
			break;
		}

		upper = oldest - 1;
		offset = undefined;
	}

	return rows;
}

// Walks a telemetry view a page at a time. A view whose rows carry a cursor
// id pages by cursor; otherwise the walk steps the timeframe's upper bound
// back to the oldest row's own millisecond: stepping past it would drop the
// rows sharing that millisecond which did not fit the page, exactly the
// bursts a push incident produces. The boundary millisecond is re-read on
// the next page and its already-collected rows dropped by content. The walk
// ends on an empty page or one that yields nothing new; the view caps a page
// below the requested limit, so a short page alone does not mean the window
// is drained.
export async function fetchPaged(
	query: TelemetryQuery,
	view: 'events' | 'traces',
	window: TimeWindow,
	timestampOf: (row: unknown) => number | undefined,
	cursorOf: ((row: unknown) => string | undefined) | undefined,
	onPage: PageProgress,
	sleep: Sleep = defaultSleep,
	// In session mode the walk stops once the collected rows bracket a gap this
	// wide: the trailing session is then complete and the older rows behind it
	// would only be filtered back out. Left undefined for a fixed `--since`
	// window, which is fetched to its end.
	stopAtGapMs?: number
): Promise<unknown[]> {
	if (cursorOf !== undefined) {
		return fetchByCursor(
			query,
			view,
			window,
			cursorOf,
			timestampOf,
			onPage,
			sleep,
			stopAtGapMs
		);
	}

	const rows: unknown[] = [];
	const timestamps: number[] = [];
	const pageSize = new AdaptivePageLimit();
	let upper = window.to;
	let boundary = new Set<string>();

	for (;;) {
		const response = await queryPageWithRetry(
			query,
			{
				view,
				timeframe: { from: window.from, to: upper }
			},
			pageSize,
			sleep
		);

		const page = pageRowsOf(response, view);
		const fresh = page.filter((row) => !boundary.has(JSON.stringify(row)));

		if (fresh.length === 0) {
			if (page.length > 0) {
				// The whole page sits at one already-collected millisecond: a burst
				// larger than one page, which the view offers no cursor into. Say
				// so rather than silently presenting the walk as complete.
				console.warn(
					`telemetry ${view} truncated at ${String(upper)}: a same-millisecond burst exceeds one page`
				);
			}

			break;
		}

		rows.push(...fresh);
		onPage(fresh.length);

		if (stopAtGapMs !== undefined) {
			for (const row of fresh) {
				const at = timestampOf(row);

				if (at !== undefined) {
					timestamps.push(at);
				}
			}

			if (hasSessionBoundary(timestamps, stopAtGapMs)) {
				break;
			}
		}

		const oldest = Math.min(...fresh.map((row) => timestampOf(row) ?? upper));

		if (!Number.isFinite(oldest)) {
			break;
		}

		const atBoundary = fresh
			.filter((row) => timestampOf(row) === oldest)
			.map((row) => JSON.stringify(row));

		// At a repeated upper bound the boundary set grows instead of resetting,
		// so the walk always either moves back in time or converges on the
		// nothing-new break above.
		boundary =
			oldest === upper
				? new Set([...boundary, ...atBoundary])
				: new Set(atBoundary);
		upper = oldest;

		if (upper <= window.from) {
			break;
		}
	}

	return rows;
}

/**
Splits a window into up to `maxSlices` slices of about `sliceTargetMinutes`.
*/
export function sliceWindow(window: TimeWindow): TimeWindow[] {
	const span = window.to - window.from;

	if (span <= 0) {
		return [window];
	}

	const count = Math.min(
		maxSlices,
		Math.max(1, Math.round(span / (sliceTargetMinutes * 60 * 1000)))
	);
	const size = Math.ceil(span / count);
	const slices: TimeWindow[] = [];

	for (let index = 0; index < count; index += 1) {
		const from = window.from + index * size;

		if (from > window.to) {
			break;
		}

		// The last slice reaches the window's end so the inclusive final
		// millisecond is covered and no stray sliver is left over.
		const to =
			index === count - 1 ? window.to : Math.min(window.to, from + size - 1);
		slices.push({ from, to });
	}

	return slices;
}

/**
Runs `task` over `items`, at most `limit` in flight, preserving order.
*/
async function mapWithConcurrency<T, R>(
	items: readonly T[],
	limit: number,
	task: (item: T) => Promise<R>
): Promise<R[]> {
	const results: R[] = Array.from({ length: items.length });
	let next = 0;

	const worker = async (): Promise<void> => {
		for (let index = next++; index < items.length; index = next++) {
			const item = items[index];

			if (item !== undefined) {
				results[index] = await task(item);
			}
		}
	};

	await Promise.all(
		Array.from({ length: Math.min(limit, items.length) }, () => worker())
	);

	return results;
}

type TelemetryView = 'events' | 'traces';

interface ViewProgress {
	rows: number;
	pages: number;
	slicesDone: number;
}

const timestampOf: Record<TelemetryView, (row: unknown) => number | undefined> =
	{
		events: (row) => eventSchema.safeParse(row).data?.timestamp,
		traces: (row) => traceSchema.safeParse(row).data?.traceStartMs
	};

const eventCursorSchema = z.object({
	$metadata: z.object({ id: z.string() })
});

// An event's id is the API's pagination cursor. The traces view ignores the
// offset parameter and replays its first page, so it has no cursor extractor
// and pages by stepping the timeframe instead.
const cursorOf: Record<
	TelemetryView,
	((row: unknown) => string | undefined) | undefined
> = {
	events: (row) => eventCursorSchema.safeParse(row).data?.$metadata.id,
	traces: undefined
};

// Both views and every slice share one bounded pool of in-flight queries.
// Disjoint slices need no dedup; their rows are concatenated per view.
//
// In session mode (`stopAtGapMs` set) the window is left whole rather than
// sliced: each view is walked newest-first and stops at the first gap this wide,
// so only the trailing session is fetched instead of the entire search window.
// This relies on a request emitting its log and its trace together, so a quiet
// gap in one view is a quiet gap in the other. A fixed `--since` window is
// sliced and fetched in full.
async function fetchTelemetry(
	client: Cloudflare,
	accountId: string,
	worker: string,
	window: TimeWindow,
	stopAtGapMs: number | undefined,
	onProgress: (
		view: TelemetryView,
		progress: ViewProgress,
		sliceCount: number
	) => void
): Promise<Record<TelemetryView, unknown[]>> {
	const slices = stopAtGapMs === undefined ? sliceWindow(window) : [window];
	const views: readonly TelemetryView[] = ['events', 'traces'];
	const progress: Record<TelemetryView, ViewProgress> = {
		events: { rows: 0, pages: 0, slicesDone: 0 },
		traces: { rows: 0, pages: 0, slicesDone: 0 }
	};
	const out: Record<TelemetryView, unknown[]> = { events: [], traces: [] };

	const tasks = views.flatMap((view) =>
		slices.map((slice) => ({ view, slice }))
	);

	const query: TelemetryQuery = (parameters) =>
		client.workers.observability.telemetry.query({
			account_id: accountId,
			queryId: 'cupboard-diagnose-push',
			parameters: { filters: [serviceFilter(worker)] },
			...parameters
		});

	await mapWithConcurrency(tasks, fetchConcurrency, async ({ view, slice }) => {
		const rows = await fetchPaged(
			query,
			view,
			slice,
			timestampOf[view],
			cursorOf[view],
			(pageRows) => {
				progress[view].rows += pageRows;
				progress[view].pages += 1;
				onProgress(view, progress[view], slices.length);
			},
			defaultSleep,
			stopAtGapMs
		);
		progress[view].slicesDone += 1;
		onProgress(view, progress[view], slices.length);

		// A slice can hold tens of thousands of rows; spreading them into push
		// would overflow the argument stack, so append element by element.
		for (const row of rows) {
			out[view].push(row);
		}
	});

	return out;
}

/**
 * Renders the analysis: the result card and per-group notes in terminal mode.
 * JSON mode writes the analysis alone to stdout, apart from the progress
 * events on stderr, so it can be piped or redirected on its own.
 */
export function renderAnalysis(
	ui: CliUi,
	reporter: Reporter,
	mode: ReporterMode,
	analysis: Analysis
): void {
	if (mode === 'json') {
		reporter.data(JSON.stringify(analysis));

		return;
	}

	reporter.result({
		kind: 'push-diagnostic',
		data: analysis,
		rows: summaryRows(analysis)
	});

	for (const group of analysis.groups) {
		ui.note(
			`${group.group} · ${formatMs(group.tracedServerMs)} · ${formatCount(group.traceCount)} traced`,
			operationRows(group.operations)
		);
	}

	if (analysis.slowest.length > 0) {
		ui.note('Slowest invocations', slowestRows(analysis));
	}
}

async function main(): Promise<void> {
	const now = Date.now();
	const options = parseOptions(argv.slice(2));

	const ui = createCliUi({ mode: options.mode });
	const reporter = ui.reporter();

	ui.intro(`Push diagnostic: ${options.worker}`);

	const accessToken = await authenticate(ui, options, now);
	const client = new Cloudflare({ apiToken: accessToken });
	const accountId = await resolveAccountId(client, options.account);

	// A fixed `--since` window must be fetched in full; otherwise look back over
	// the search window and narrow to the most recent session afterwards. Either
	// way the fetch has to reach back as far as the window the report will cover.
	const lookbackMinutes = Math.max(
		options.searchMinutes,
		options.sinceMinutes ?? 0
	);
	const searchWindow: TimeWindow = {
		from: now - lookbackMinutes * 60 * 1000,
		to: now
	};
	const lookbackLabel =
		lookbackMinutes >= 60 && lookbackMinutes % 60 === 0
			? `${String(lookbackMinutes / 60)}h`
			: `${String(lookbackMinutes)}m`;

	// Without a fixed `--since`, only the most recent session is reported, so the
	// fetch stops at the first gap this wide rather than draining the whole
	// search window.
	const stopAtGapMs =
		options.sinceMinutes === undefined ? options.gapMs : undefined;

	const { rawEvents, rawTraces } = await reporter.phase(
		`Fetching ${lookbackLabel} of logs and traces (account ${accountId})`,
		async (context) => {
			const fetched = await fetchTelemetry(
				client,
				accountId,
				options.worker,
				searchWindow,
				stopAtGapMs,
				(view, progress, sliceCount) => {
					const slices =
						sliceCount > 1
							? ` · ${String(progress.slicesDone)}/${String(sliceCount)} slices`
							: '';

					context.fact(
						view,
						`${formatCount(progress.rows)} rows · ${String(progress.pages)} pages${slices}`
					);
				}
			);

			return { rawEvents: fetched.events, rawTraces: fetched.traces };
		}
	);

	// The events view carries the worker's logs and its trace spans together; each
	// raw event is one or the other, so both are read from the one fetch.
	const { logs, traces, spans } = await reporter.phase(
		`Parsing ${formatCount(rawEvents.length + rawTraces.length)} telemetry rows`,
		(context) => {
			const parsedLogs = rawEvents
				.map((event) => parseWorkerLog(event))
				.filter((log): log is WorkerLog => log !== undefined);
			const parsedSpans = rawEvents
				.map((event) => parseSpanEvent(event))
				.filter((span): span is SpanEvent => span !== undefined);
			const parsedTraces = rawTraces
				.map((trace) => parseTraceSummary(trace))
				.filter((trace): trace is TraceSummary => trace !== undefined);

			context.fact('logs', formatCount(parsedLogs.length));
			context.fact('traces', formatCount(parsedTraces.length));
			context.fact('spans', formatCount(parsedSpans.length));

			return { logs: parsedLogs, traces: parsedTraces, spans: parsedSpans };
		}
	);

	const analysis = await reporter.phase('Analysing', (context) => {
		const window =
			options.sinceMinutes === undefined
				? (detectSession(
						[...logs.map((l) => l.timestamp), ...traces.map((t) => t.startMs)],
						options.gapMs
					) ?? searchWindow)
				: { from: now - options.sinceMinutes * 60 * 1000, to: now };

		const windowSource: 'fixed' | 'session' =
			options.sinceMinutes === undefined ? 'session' : 'fixed';

		const isInWindow = (stamp: number): boolean =>
			stamp >= window.from && stamp <= window.to;

		const windowedSpans = spans.filter((span) => isInWindow(span.startMs));
		context.fact('spans in window', formatCount(windowedSpans.length));

		return analyse(
			options.worker,
			window,
			windowSource,
			logs.filter((log) => isInWindow(log.timestamp)),
			traces.filter((trace) => isInWindow(trace.startMs)),
			windowedSpans
		);
	});

	renderAnalysis(ui, reporter, options.mode, analysis);

	ui.outro('Done');
}

if (argv[1] !== undefined && import.meta.url === pathToFileURL(argv[1]).href) {
	try {
		await main();
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`diagnose-push failed: ${message}`);
		exit(error instanceof CodedError ? error.exitCode : genericExitCode);
	}
}
