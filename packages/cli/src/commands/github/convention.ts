// The reuse-view name and per-PR cache prefix the quickstart uses. Setup
// writes them and check verifies them, so the one spelling lives here.
export const pullRequestViewName = 'pull-requests';
export const pullRequestPrefix = 'pr-';

// The grace below which the plan-to-target span of a busy run is at real
// risk of outliving its intermediates' deadlines. Setup refuses to store
// less and check fails a stored policy under it, so the two cannot drift.
export const minimumGraceSeconds = 3600;
