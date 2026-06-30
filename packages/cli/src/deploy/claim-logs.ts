import { throwIfAborted } from '../abort.ts';

import type { CloudflareApi, WorkerLogEvent } from './cloudflare-api.ts';

const lookbackMs = 2 * 60_000;
const lookaheadMs = 5000;
const ingestionAttempts = 4;
const ingestionDelayMs = 2500;
const eventLimit = 20;

export interface ClaimLogDependencies {
	readonly api: Pick<CloudflareApi, 'queryWorkerLogs'>;
	/** The cf-ray of the refused request, matched against each event. */
	readonly ray: string;
	readonly now: () => number;
	readonly sleep: (ms: number) => Promise<void>;
	readonly attempts?: number;
	readonly signal?: AbortSignal;
}

/**
 * The exception lines the control Worker logged for a refused request, found by
 * its cf-ray. Workers Observability lags the request by a few seconds, so the
 * query is retried before giving up. An empty result means nothing was found
 * (observability is off, the credential cannot read it, the query failed, or
 * the log has not been ingested yet), leaving the caller to fall back to
 * pointing at the logs.
 */
export async function fetchClaimFailureLogs(
	dependencies: ClaimLogDependencies
): Promise<readonly string[]> {
	const queriedAt = dependencies.now();
	const attempts = dependencies.attempts ?? ingestionAttempts;

	for (let attempt = 1; attempt <= attempts; attempt += 1) {
		throwIfAborted(dependencies.signal);

		let events: readonly WorkerLogEvent[];

		try {
			events = await dependencies.api.queryWorkerLogs({
				needle: dependencies.ray,
				fromMs: queriedAt - lookbackMs,
				toMs: queriedAt + lookaheadMs,
				limit: eventLimit
			});
		} catch {
			throwIfAborted(dependencies.signal);

			// Reading the log is best-effort: the deploy credential may lack the
			// Workers Observability scope, or the query may be unavailable. The
			// caller still has the server fault to report and points at the log.
			return [];
		}

		const lines = logLines(events);

		if (lines.length > 0) {
			return lines;
		}

		if (attempt < attempts) {
			await dependencies.sleep(ingestionDelayMs);
		}
	}

	return [];
}

/**
 * The most telling text from each event (the error, else the message, else the
 * raw source), de-duplicated and stripped of blanks.
 */
export function logLines(events: readonly WorkerLogEvent[]): string[] {
	const lines = new Set<string>();

	for (const event of events) {
		const text = (event.error ?? event.message ?? event.source).trim();

		if (text !== '') {
			lines.add(text);
		}
	}

	return [...lines];
}
