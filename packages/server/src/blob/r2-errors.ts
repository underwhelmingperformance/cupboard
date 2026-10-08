/**
 * R2's error code for a body whose SHA-256 differs from the `sha256` option of
 * the put.
 */
export const r2BadDigestCode = 10_037;

const r2ErrorCodePattern = /\((?<code>\d+)\)$/u;

/**
 * Returns the R2 error code of an error from the R2 binding. The binding
 * reports failures as plain `Error` objects whose message ends with the code in
 * parentheses.
 */
export function r2ErrorCode(error: unknown): number | undefined {
	if (!(error instanceof Error)) {
		return undefined;
	}

	const code = r2ErrorCodePattern.exec(error.message)?.groups?.code;

	return code === undefined ? undefined : Number(code);
}

export function isR2BadDigest(error: unknown): boolean {
	return r2ErrorCode(error) === r2BadDigestCode;
}
