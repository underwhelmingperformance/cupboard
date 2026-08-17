import type { ObjectStat } from './ports.ts';
import { quoteEtag } from './xml.ts';

export type PreconditionOutcome = 'ok' | 'not-modified' | 'precondition-failed';

/**
 * Evaluates the HTTP conditional headers (`If-Match`, `If-None-Match`,
 * `If-Modified-Since` and `If-Unmodified-Since`) according to S3's precedence
 * rules. `If-Match` and `If-Unmodified-Since` can fail the request with `412`.
 * For a read, `If-None-Match` and `If-Modified-Since` can return `304`.
 */
export function evaluatePreconditions(
	headers: Headers,
	stat: ObjectStat
): PreconditionOutcome {
	const etag = quoteEtag(stat.etag);

	const ifMatch = headers.get('if-match');
	if (ifMatch !== null && !isEtagMatch(ifMatch, etag)) {
		return 'precondition-failed';
	}

	const ifUnmodifiedSince = parseHttpDate(headers.get('if-unmodified-since'));
	if (
		ifMatch === null &&
		ifUnmodifiedSince !== undefined &&
		isModifiedAfter(stat.lastModified, ifUnmodifiedSince)
	) {
		return 'precondition-failed';
	}

	const ifNoneMatch = headers.get('if-none-match');
	if (ifNoneMatch !== null) {
		return isEtagMatch(ifNoneMatch, etag) ? 'not-modified' : 'ok';
	}

	const ifModifiedSince = parseHttpDate(headers.get('if-modified-since'));
	if (
		ifModifiedSince !== undefined &&
		!isModifiedAfter(stat.lastModified, ifModifiedSince)
	) {
		return 'not-modified';
	}

	return 'ok';
}

function isEtagMatch(header: string, etag: string): boolean {
	if (header.trim() === '*') {
		return true;
	}

	return header
		.split(',')
		.map((candidate) => candidate.trim())
		.includes(etag);
}

// An `If-Modified-Since`/`If-Unmodified-Since` value, in epoch milliseconds, or
// `undefined` when the header is absent or carries an unparseable date. RFC 9110
// requires a recipient to ignore an invalid conditional date, so a caller treats
// `undefined` as if the header were not sent.
function parseHttpDate(value: string | null): number | undefined {
	if (value === null) {
		return undefined;
	}

	const parsed = Date.parse(value);
	return Number.isNaN(parsed) ? undefined : parsed;
}

function isModifiedAfter(lastModified: Date, since: number): boolean {
	// HTTP dates have second precision; compare at that resolution.
	return Math.floor(lastModified.getTime() / 1000) > Math.floor(since / 1000);
}
