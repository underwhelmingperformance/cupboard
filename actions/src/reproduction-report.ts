import path from 'node:path';

import type { BuildReceipt } from '@cupboard/protocol/build';
import {
	reproducibleAttribute,
	type ScaiAttributeReport,
	scaiAttributeReportSchema
} from '@cupboard/protocol/scai';

export interface ReproducedSubject {
	readonly storePath: string;
	readonly sha256: string;
	readonly derivation: string;
}

export function reproducedSubjects(
	receipt: BuildReceipt
): readonly ReproducedSubject[] {
	if (receipt.version !== 3) {
		return [];
	}

	return receipt.subjects.flatMap((subject) => {
		if (
			subject.origin !== 'built' ||
			subject.verification !== 'local' ||
			subject.machine !== undefined ||
			subject.reproduced !== true
		) {
			return [];
		}

		return [
			{
				storePath: subject.storePath,
				sha256: subject.narHash,
				derivation: subject.derivation
			}
		];
	});
}

export function reproductionReport(
	subjects: readonly ReproducedSubject[],
	isSoleSubject = new Set(subjects.map((subject) => subject.sha256)).size === 1
): ScaiAttributeReport {
	return scaiAttributeReportSchema.parse({
		attributes: subjects.map((subject) => ({
			attribute: reproducibleAttribute,
			...(!isSoleSubject && {
				target: {
					name: path.basename(subject.storePath),
					digest: { sha256: subject.sha256 }
				}
			}),
			conditions: { derivation: subject.derivation }
		}))
	});
}
