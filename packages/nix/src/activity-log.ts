import { stripVTControlCharacters } from 'node:util';

import {
	storePathSchema,
	type StorePathString
} from '@cupboard/nix-store/scalars';
import { z } from 'zod';

import type { NixBuildOutcome } from './nix-store.ts';

// Nix emits `actCopyPath` (100) only after it has confirmed that the destination
// lacks the path and the transfer has begun. Its first three fields are the
// store path, source store and destination store, so the event proves this run
// started fetching the path from that source. Activity type 108 is emitted
// before the destination check and can also appear for an existing path.
const copyActivityStartSchema = z.object({
	action: z.literal('start'),
	type: z.literal(100),
	fields: z
		.tuple([storePathSchema, z.string().min(1), z.string().min(1)])
		.rest(z.unknown())
});

/**
Parses the records in one `json-log-path` file. Nix writes one JSON document
per line. The file comes from another process, so malformed lines are skipped
and each caller ignores unrecognised record types.
*/
export function* activityLogRecords(log: string): Generator {
	for (const line of log.split(/\r?\n/u)) {
		if (line === '') {
			continue;
		}

		try {
			yield JSON.parse(line);
		} catch {
			continue;
		}
	}
}

const copyOrBuildType = z.union([z.literal(100), z.literal(105)]);

const readRecordSchema = z.union([
	z.object({ action: z.literal('start'), type: copyOrBuildType }),
	z.object({ action: z.literal('msg'), level: z.literal(0) })
]);

/**
Whether one line of a `json-log-path` file has a record that the readers of
activity logs use: the `start` record of a copy (type 100) or of a build
(type 105), or an error message. Nix also writes a progress record for every
change in a transfer, and the readers ignore these records. A program that
reads a large log can drop each line for which this returns false.
*/
export function isReadActivityLogLine(line: string): boolean {
	for (const record of activityLogRecords(line)) {
		return readRecordSchema.safeParse(record).success;
	}

	return false;
}

/**
Extracts copy evidence from the supplied activity logs. Each map entry lists
the source stores from this run's `actCopyPath` events, deduplicated in log
order. Several sources mean that Nix started more than one transfer for the
path, for example after a fetch failed.

The map omits paths with no copy event in these logs. This includes paths
that were already valid and copies performed outside these invocations.
*/
export function copySources(
	logs: readonly string[]
): ReadonlyMap<StorePathString, readonly string[]> {
	const sources = new Map<StorePathString, string[]>();

	for (const log of logs) {
		recordCopySources(log, sources);
	}

	return sources;
}

function recordCopySources(
	log: string,
	sources: Map<StorePathString, string[]>
): void {
	for (const record of activityLogRecords(log)) {
		const start = copyActivityStartSchema.safeParse(record);

		if (!start.success) {
			continue;
		}

		const [storePath, source] = start.data.fields;
		const recorded = sources.get(storePath) ?? [];

		if (!recorded.includes(source)) {
			recorded.push(source);
		}

		sources.set(storePath, recorded);
	}
}

const buildFailureMessageSchema = z.object({
	action: z.literal('msg'),
	level: z.literal(0),
	msg: z.string(),
	raw_msg: z.string().optional()
});

export interface BuilderFailure {
	readonly derivation: StorePathString;
	/**
	Whether Nix added its note that a full disk may have caused the failure.
	*/
	readonly isDiskFull: boolean;
}

const diskFullNote =
	'\nnote: build failure may have been caused by lack of free disk space';

function* errorMessages(log: string): Generator<string> {
	for (const record of activityLogRecords(log)) {
		const parsed = buildFailureMessageSchema.safeParse(record).data;

		if (parsed !== undefined) {
			yield stripVTControlCharacters(parsed.raw_msg ?? parsed.msg);
		}
	}
}

/**
The failure statuses of Nix's `BuildResult`. A `nix build` activity log has no
record of the status itself, so {@link buildFailureStatuses} recovers it from
the wording of the error message.
*/
export type NixBuildFailureKind = Extract<
	NixBuildOutcome,
	{ readonly message: string }
>['kind'];

export interface BuildFailureStatus {
	readonly kind: NixBuildFailureKind;
	/**
	The derivation that the message is about, when the message names one.
	*/
	readonly derivation?: StorePathString;
}

// An error message about a failed builder continues with the output paths and
// the last lines of the builder's log, which can quote any text.
const failureMessageTail = /\n(?:Output paths:|Last \d+ log lines:)/u;

// Nix 2.34.8 words these failures as below. A local build logs each message
// twice: `msg` starts with `error: ` and indents the lines after the first,
// and `raw_msg` has neither. A build through the daemon has only `msg`. The
// daemon reports `input-rejected` for the three reasons that no machine can
// build the derivation. A timeout has no derivation in its message, except
// when the build hook reports it for a remote machine.
//
// For a remote build, the hook reports every failure of the remote machine as
// `build of '<drv>' on '<store>' failed: <message of the remote failure>`
// (build-remote.cc). The patterns match the message after that prefix, and the
// derivation comes from the prefix.
const hookFailurePrefix = /^(?:error: )?build of '[^']+' on '[^']+' failed: /u;

const failureKindPatterns: readonly (readonly [RegExp, NixBuildFailureKind])[] =
	[
		[
			/^(?:error: )?derivation '[^']+' may not be deterministic/u,
			'not-deterministic'
		],
		[
			/^(?:error: )?Cannot build '[^']+'\.\nReason: (?:missing system features|platform mismatch|local builds are disabled)/u,
			'input-rejected'
		],
		[
			/^(?:error: )?Cannot build '[^']+'\.\nReason: \d+ dependenc(?:y|ies) failed/u,
			'dependency-failed'
		],
		[/^(?:error: )?timed out after \d+ seconds/u, 'timed-out'],
		[
			/^(?:error: )?[^\n]* killed after writing more than \d+ bytes of log output/u,
			'log-limit-exceeded'
		],
		[
			/^(?:error: )?(?:hash mismatch in fixed-output derivation '|builder for '[^']+' failed to produce output path for output |output '[^']+' is not allowed to refer to the following paths)/u,
			'output-rejected'
		]
	];

const derivationInMessage = /'([^']+\.drv)'/u;

/**
Returns the failure status of each error message in one activity log that
Nix words as a failure with a known status, in log order. Most messages
about a failed builder have the status `permanent-failure` in Nix, and
{@link builderFailures} reports them. A message that matches no known
wording has no entry.
*/
export function buildFailureStatuses(
	log: string
): readonly BuildFailureStatus[] {
	const statuses: BuildFailureStatus[] = [];

	for (const message of errorMessages(log)) {
		const [header = ''] = message
			.replaceAll(/\n[ \t]+/gu, '\n')
			.split(failureMessageTail);
		const remoteMessage = header.replace(hookFailurePrefix, '');
		const kind = failureKindPatterns.find(([pattern]) =>
			pattern.test(remoteMessage)
		)?.[1];

		if (kind === undefined) {
			continue;
		}

		const derivation = storePathSchema.safeParse(
			derivationInMessage.exec(header)?.[1]
		).data;

		statuses.push(derivation === undefined ? { kind } : { kind, derivation });
	}

	return statuses;
}

const unreachableBuilderMessage = /^(?:error: )?cannot build on '([^']+)': /u;

/**
Returns the store URI of each remote builder that the build hook failed to
use in one activity log, in log order. After a failure the hook stops using
the machine for the rest of the build. When no enabled machine is left for
the derivation, Nix reports `input-rejected` ("platform mismatch", "missing
system features" or "local builds are disabled"), the same status that it
reports when no configured machine ever matched. This list tells the two
apart, because only the first follows from a failed connection.
*/
export function unreachableBuilders(log: string): readonly string[] {
	return errorMessages(log)
		.map((message) => unreachableBuilderMessage.exec(message)?.[1])
		.filter((uri) => uri !== undefined)
		.toArray();
}

/**
Returns each derivation whose builder failed in one activity log, in log
order. Messages about failed dependencies do not identify a failed builder.
*/
export function builderFailures(log: string): readonly BuilderFailure[] {
	const failures: BuilderFailure[] = [];

	for (const message of errorMessages(log)) {
		// Match only the start of the message. The log tail of a failed builder can
		// quote a failure from a nested Nix invocation.
		const failed =
			/^(?:error: )?Cannot build '([^']+\.drv)'\.\n\s*Reason: builder /u.exec(
				message
			) ?? /^(?:error: )?builder for '([^']+\.drv)' failed/u.exec(message);
		const derivation = storePathSchema.safeParse(failed?.[1]).data;

		if (derivation !== undefined) {
			failures.push({ derivation, isDiskFull: message.endsWith(diskFullNote) });
		}
	}

	return failures;
}

/**
Returns the first derivation whose builder failed in the supplied activity
logs.
*/
export function firstBuildFailure(
	logs: readonly string[]
): StorePathString | undefined {
	return logs.flatMap((log) => builderFailures(log)).at(0)?.derivation;
}
