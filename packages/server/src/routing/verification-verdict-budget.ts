import { type UploadId } from '@cupboard/protocol/upload';
import { positiveSafeInteger } from '@cupboard/shared/limits';

import {
	holdSubrequests,
	spendSubrequests,
	type SubrequestHold
} from '../do/subrequest-slice.ts';
import { SubrequestSliceExceededError } from '../errors.ts';

/**
 * Reserves verdict retries until the corresponding uploads are recorded or
 * the verification pass ends.
 */
export class VerificationVerdictBudget {
	private readonly reservations = new Map<UploadId, SubrequestHold[]>();
	constructor(uploads: readonly UploadId[], attempts: number) {
		const count = positiveSafeInteger(
			attempts,
			'verification verdict attempts'
		);
		const unique = new Set(uploads);
		for (const upload of unique) {
			this.reservations.set(
				upload,
				Array.from({ length: count }, () => holdSubrequests(1))
			);
		}
	}
	consume(uploads: readonly UploadId[]): void {
		for (const upload of uploads) {
			const reserved = this.reservations.get(upload)?.pop();
			if (reserved === undefined) {
				continue;
			}
			reserved.release();
			spendSubrequests(1, 'verification.record');
			return;
		}
		throw new SubrequestSliceExceededError('verification.record', 1);
	}
	recorded(uploads: readonly UploadId[]): void {
		for (const upload of uploads) {
			const remaining = this.reservations.get(upload) ?? [];
			for (const reserved of remaining) {
				reserved.release();
			}
			this.reservations.delete(upload);
		}
	}
	dispose(): void {
		this.recorded(this.reservations.keys().toArray());
	}
}
