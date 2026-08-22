interface TimestampAuthorityEvidence {
	readonly $case: 'timestamp-authority';
}

interface TransparencyLogTimestampEvidence {
	readonly $case: 'transparency-log';
	readonly tlogEntry: {
		readonly inclusionPromise?: unknown;
	};
}

type TimestampEvidence =
	TimestampAuthorityEvidence | TransparencyLogTimestampEvidence;

/**
Counts timestamp evidence that the Sigstore verifier actually verifies.
*/
export function verifiedTimestampCount(
	timestamps: readonly TimestampEvidence[]
): number {
	return timestamps.filter(
		(timestamp) =>
			timestamp.$case === 'timestamp-authority' ||
			timestamp.tlogEntry.inclusionPromise !== undefined
	).length;
}

/**
Formats a Rekor integration time when it is in JavaScript's date range.
*/
export function isoFromUnixSeconds(seconds: string): string | undefined {
	const value = Number(seconds);

	if (!Number.isFinite(value) || value <= 0) {
		return undefined;
	}

	const date = new Date(value * 1000);

	return Number.isFinite(date.getTime()) ? date.toISOString() : undefined;
}
