import { describe, expect, it } from 'vitest';

import { upstreamTraceAttributes } from './trace-context.ts';

const traceId = '4bf92f3577b34da6a3ce929d0e0e4736';
const spanId = '00f067aa0ba902b7';
const parent = `00-${traceId}-${spanId}-01`;

describe('upstream W3C trace context', () => {
	it('reads validated identifiers forwarded after public trace headers are removed', () => {
		expect(
			upstreamTraceAttributes(
				new Headers({
					'x-cupboard-client-trace-id': traceId,
					'x-cupboard-client-span-id': spanId
				})
			)
		).toStrictEqual({
			'cupboard.upstream.trace_id': traceId,
			'cupboard.upstream.span_id': spanId
		});
	});

	it.each(['00', '01'])(
		'extracts valid trace identifiers with flags %s',
		(flags) => {
			const headers = new Headers({
				traceparent: `00-${traceId}-${spanId}-${flags}`,
				tracestate: 'vendor=private-value',
				authorization: 'Bearer secret',
				cookie: 'secret=value'
			});
			expect(upstreamTraceAttributes(headers)).toStrictEqual({
				'cupboard.upstream.trace_id': traceId,
				'cupboard.upstream.span_id': spanId
			});
		}
	);
	it.each([
		undefined,
		'secret',
		`00-${'0'.repeat(32)}-${spanId}-01`,
		`00-${traceId}-${'0'.repeat(16)}-01`,
		`ff-${traceId}-${spanId}-01`,
		`${parent},${parent}`,
		`${parent}-extra`
	])('omits absent or invalid trace context %s', (value) => {
		const headers = new Headers();
		if (value !== undefined) {
			headers.set('traceparent', value);
		}
		expect(upstreamTraceAttributes(headers)).toStrictEqual({});
	});
});
