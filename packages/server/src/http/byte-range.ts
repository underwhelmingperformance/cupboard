export type ByteRange =
	| { readonly kind: 'full' }
	| { readonly kind: 'unsatisfiable' }
	| {
			readonly kind: 'partial';
			readonly offset: number;
			readonly length: number;
	  };

/**
 * Selects one byte range. Unsupported units, malformed ranges and multipart
 * requests select the complete representation.
 */
export function requestedByteRange(
	request: Request,
	object: R2Object
): ByteRange {
	if (request.method !== 'GET') {
		return { kind: 'full' };
	}
	const validator = request.headers.get('if-range');
	if (
		validator !== null &&
		validator !== object.httpEtag &&
		validator !== object.uploaded.toUTCString()
	) {
		return { kind: 'full' };
	}
	const header = request.headers.get('range');
	const match = header?.match(/^bytes=(\d*)-(\d*)$/u);
	const start = match?.[1];
	const end = match?.[2];
	if (
		start === undefined ||
		end === undefined ||
		(start === '' && end === '')
	) {
		return { kind: 'full' };
	}
	const size = BigInt(object.size);
	if (start === '') {
		const suffix = BigInt(end);
		if (suffix === 0n || size === 0n) {
			return { kind: 'unsatisfiable' };
		}
		const length = Math.min(Number(suffix), object.size);
		return {
			kind: 'partial',
			offset: object.size - length,
			length
		};
	}
	const offset = BigInt(start);
	const last = end === '' ? size - 1n : BigInt(end);
	if (end !== '' && offset > last) {
		return { kind: 'full' };
	}
	if (offset >= size) {
		return { kind: 'unsatisfiable' };
	}
	const boundedLast = Math.min(Number(last), object.size - 1);
	return {
		kind: 'partial',
		offset: Number(offset),
		length: boundedLast - Number(offset) + 1
	};
}
