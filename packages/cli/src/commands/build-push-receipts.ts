import {
	type BuildReceipt,
	type BuildReceiptV4,
	buildReceiptV4Schema
} from '@cupboard/protocol/build';
import { InvalidArgumentError } from 'commander';

interface ReceiptConsumer {
	readonly receiptFile?: string;
	readonly aggregateReceiptV3?: boolean;
	readonly aggregateReceipt?: readonly number[];
}

export class BuildReceiptNegotiation {
	static forConsumer(options: ReceiptConsumer): BuildReceiptNegotiation {
		if (
			options.aggregateReceiptV3 === true &&
			options.aggregateReceipt !== undefined
		) {
			throw new InvalidArgumentError(
				'Use either --aggregate-receipt or --aggregate-receipt-v3.'
			);
		}

		const requested =
			options.aggregateReceiptV3 === true ? [3] : options.aggregateReceipt;
		const accepted =
			requested ?? (options.receiptFile === undefined ? [3, 4] : [3]);
		const version = ([4, 3] as const).find((value) => accepted.includes(value));
		if (version === undefined) {
			throw new InvalidArgumentError(
				'No compatible build receipt version. This CLI supports versions 3 and 4.'
			);
		}

		return new BuildReceiptNegotiation(
			version,
			options.aggregateReceiptV3 === true ||
				options.aggregateReceipt !== undefined
		);
	}

	private constructor(
		readonly version: 3 | 4,
		readonly shouldAggregate: boolean
	) {}

	receive<T extends BuildReceipt>(receipt: T): T | BuildReceiptV4 {
		if (this.version === 3 && receipt.version === 4) {
			throw new InvalidArgumentError(
				'Version 3 cannot represent compact publication sets.'
			);
		}
		if (this.version === 4 && receipt.version === 3) {
			return buildReceiptV4Schema.parse({ ...receipt, version: 4 });
		}

		return receipt;
	}
}

export function parseReceiptVersions(value: string): readonly number[] {
	const versions = value.split(',').map((part) => {
		const trimmed = part.trim();
		const version = Number(trimmed);
		if (
			!/^\d+$/.test(trimmed) ||
			!Number.isSafeInteger(version) ||
			version < 1
		) {
			throw new InvalidArgumentError(
				'Accepted receipt versions must be positive integers separated by commas.'
			);
		}

		return version;
	});

	return [...new Set(versions)];
}
