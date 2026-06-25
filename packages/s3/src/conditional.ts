import type { ObjectStat } from './ports.ts';
import { quoteEtag } from './xml.ts';

export type PreconditionOutcome = 'ok' | 'not-modified' | 'precondition-failed';

/**
 * Evaluates the HTTP conditional headers (`If-Match`, `If-None-Match`,
 * `If-Modified-Since`, `If-Unmodified-Since`) against an object's current
 * state, following the S3 precedence: `If-Match` and `If-Unmodified-Since`
 * gate the response (`412`); `If-None-Match` and `If-Modified-Since` can short
 * it to `304` on a read.
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

	const ifUnmodifiedSince = headers.get('if-unmodified-since');
	if (
		ifMatch === null &&
		ifUnmodifiedSince !== null &&
		isModifiedAfter(stat.lastModified, ifUnmodifiedSince)
	) {
		return 'precondition-failed';
	}

	const ifNoneMatch = headers.get('if-none-match');
	if (ifNoneMatch !== null) {
		return isEtagMatch(ifNoneMatch, etag) ? 'not-modified' : 'ok';
	}

	const ifModifiedSince = headers.get('if-modified-since');
	if (
		ifModifiedSince !== null &&
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

function isModifiedAfter(lastModified: Date, since: string): boolean {
	const sinceTime = Date.parse(since);
	if (Number.isNaN(sinceTime)) {
		return true;
	}

	// HTTP dates have second precision; compare at that resolution.
	return (
		Math.floor(lastModified.getTime() / 1000) > Math.floor(sinceTime / 1000)
	);
}
