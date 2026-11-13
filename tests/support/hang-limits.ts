/**
The limits that every Vitest configuration sets for a test and for a hook:
30 minutes. They only detect a hung test or hook. A shorter limit makes the
result of a test depend on how busy the machine is. The "Time and
synchronisation" section of `docs/contributing/testing.md` says where to
spread this object.
*/
export const hangLimits = {
	hookTimeout: 1_800_000,
	testTimeout: 1_800_000
} as const;
