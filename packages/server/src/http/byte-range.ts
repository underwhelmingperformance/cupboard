/**
The bytes of a representation to send in a `206 Partial Content` response.
*/
export interface ByteSpan {
	readonly offset: number;
	readonly length: number;
}

/**
How to answer a range request for a representation of a known size.

`whole` means a full `200` response. `contentRange` is the value of the
response's `Content-Range` header.
*/
export type ByteRangeSelection =
	| {
			readonly kind: 'partial';
			readonly span: ByteSpan;
			readonly contentRange: string;
	  }
	| { readonly kind: 'unsatisfiable'; readonly contentRange: string }
	| { readonly kind: 'whole' };

type RangeSpec =
	| { readonly kind: 'from'; readonly first: number }
	| { readonly kind: 'bounded'; readonly first: number; readonly last: number }
	| { readonly kind: 'suffix'; readonly length: number };

const singleRangePattern = /^bytes=[\t ]*(\d*)-(\d*)[\t ]*$/iu;

const whole: ByteRangeSelection = { kind: 'whole' };

/**
A request for one byte range of a representation (RFC 9110, section 14).

Only GET requests can select a range. RFC 9110 permits a server to ignore
`Range`, so a request with several ranges or a malformed header receives the
whole representation.
*/
export class ByteRangeRequest {
	static of(request: Request): ByteRangeRequest | undefined {
		const header = request.headers.get('range');

		if (header === null || request.method !== 'GET') {
			return undefined;
		}

		const spec = parseRangeSpec(header);

		if (spec === undefined) {
			return undefined;
		}

		return new ByteRangeRequest(spec, request.headers.get('if-range'));
	}

	private constructor(
		private readonly spec: RangeSpec,
		private readonly ifRange: string | null
	) {}

	/**
	Whether the range has an explicit first position after byte 0, as a resumed
	download's range has. A suffix range has no explicit first position.
	*/
	startsAfterFirstByte(): boolean {
		return this.spec.kind !== 'suffix' && this.spec.first > 0;
	}

	/**
	Selects the requested bytes of a representation with this size and
	entity tag.

	When the request has an `If-Range` entity tag that does not match `etag` by
	strong comparison, RFC 9110 requires the whole representation.

	An open-ended range that starts exactly at the end of the representation
	also selects the whole representation. Nix sends such a range when a
	transfer fails after the last byte has arrived. libcurl completes the
	download on a full `200` whose `Content-Length` equals the resume offset,
	but Nix 2.34 fails it on a `416`. A bounded range that starts at the end is
	unsatisfiable.
	*/
	select(size: number, etag: string): ByteRangeSelection {
		if (this.ifRange !== null && this.ifRange.trim() !== etag) {
			return whole;
		}

		switch (this.spec.kind) {
			case 'from': {
				if (this.spec.first === size) {
					return whole;
				}

				return partialOrUnsatisfiable(this.spec.first, size - 1, size);
			}
			case 'bounded': {
				return partialOrUnsatisfiable(
					this.spec.first,
					Math.min(this.spec.last, size - 1),
					size
				);
			}
			case 'suffix': {
				if (this.spec.length === 0) {
					return unsatisfiable(size);
				}

				if (size === 0) {
					return whole;
				}

				return partialOrUnsatisfiable(
					Math.max(size - this.spec.length, 0),
					size - 1,
					size
				);
			}
		}
	}
}

function parseRangeSpec(header: string): RangeSpec | undefined {
	const match = singleRangePattern.exec(header);

	if (match === null) {
		return undefined;
	}

	const [, first = '', last = ''] = match;

	if (first === '') {
		return last === '' ? undefined : { kind: 'suffix', length: Number(last) };
	}

	if (last === '') {
		return { kind: 'from', first: Number(first) };
	}

	// RFC 9110 permits a server to ignore or reject a range whose last position
	// precedes its first (sections 14.1.1 and 14.2). Ignore it, so the response
	// is the whole representation.
	if (Number(last) < Number(first)) {
		return undefined;
	}

	return { kind: 'bounded', first: Number(first), last: Number(last) };
}

function partialOrUnsatisfiable(
	first: number,
	last: number,
	size: number
): ByteRangeSelection {
	if (first >= size) {
		return unsatisfiable(size);
	}

	return {
		kind: 'partial',
		span: { offset: first, length: last - first + 1 },
		contentRange: `bytes ${String(first)}-${String(last)}/${String(size)}`
	};
}

function unsatisfiable(size: number): ByteRangeSelection {
	return { kind: 'unsatisfiable', contentRange: `bytes */${String(size)}` };
}
