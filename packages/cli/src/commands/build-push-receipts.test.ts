import type { BuildReceiptV3 } from '@cupboard/protocol/build';
import { InvalidArgumentError } from 'commander';
import { expect, it } from 'vitest';

import {
	BuildReceiptNegotiation,
	parseReceiptVersions
} from './build-push-receipts.ts';

it.each([
	{ options: {}, expected: { version: 4, aggregate: false } },
	{
		options: { receiptFile: 'receipt.json' },
		expected: { version: 3, aggregate: false }
	},
	{
		options: { aggregateReceiptV3: true },
		expected: { version: 3, aggregate: true }
	},
	{
		options: { aggregateReceipt: [3, 4], receiptFile: 'receipt.json' },
		expected: { version: 4, aggregate: true }
	},
	{
		options: { aggregateReceipt: [4, 5, 3] },
		expected: { version: 4, aggregate: true }
	},
	{
		options: { aggregateReceipt: [3] },
		expected: { version: 3, aggregate: true }
	}
])('negotiates receipt support from $options', ({ options, expected }) => {
	const negotiation = BuildReceiptNegotiation.forConsumer(options);
	expect({
		version: negotiation.version,
		aggregate: negotiation.shouldAggregate
	}).toStrictEqual(expected);
});

it.each([
	{ aggregateReceipt: [5] },
	{ aggregateReceipt: [] },
	{ aggregateReceipt: [3, 4], aggregateReceiptV3: true }
])('rejects incompatible or conflicting receipt requests: %j', (options) => {
	expect(() => BuildReceiptNegotiation.forConsumer(options)).toThrow(
		InvalidArgumentError
	);
});

it('parses comma-separated versions without discarding future consumer support', () => {
	expect(parseReceiptVersions('3, 4,5,4')).toStrictEqual([3, 4, 5]);
});

it.each(['', '3,', '3.5', '0', '-3', 'v4', '9007199254740992'])(
	'rejects an invalid version list: %s',
	(value) => {
		expect(() => parseReceiptVersions(value)).toThrow(InvalidArgumentError);
	}
);

it('writes the negotiated V4 shape when the server uses legacy publication', () => {
	const receipt: BuildReceiptV3 = {
		version: 3,
		paths: [],
		subjects: [],
		childExitStatus: 0
	};
	const negotiation = BuildReceiptNegotiation.forConsumer({
		aggregateReceipt: [4]
	});
	expect(negotiation.receive(receipt)).toStrictEqual({
		...receipt,
		version: 4
	});
});
