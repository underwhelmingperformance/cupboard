# Workers test lifecycle

The Workers suite uses real Durable Objects and hibernatable WebSockets. A test
must therefore own the objects, alarms, and sockets that its fixture creates.
Vitest's case timeout cannot identify which asynchronous phase stopped, and it
does not close a WebSocket that a helper still owns.

## September 2026 timing investigation

Several complete suite runs stopped in large maintenance fixtures:

- the teardown and garbage collection alarm allowance test reached its
  240-second case timeout in the PR #352 and PR #354 gates;
- the cron verification allowance test reached the same timeout in the PR #366
  gate; and
- the chunk-spanning cache teardown test reached its 120-second timeout in an
  exact-tree gate.

Retries passed, including 100 isolated repetitions of the first six-upload
burst. The failures were therefore not a repeatable assertion failure. Repeated
`workerd` diagnostics in the same logs were also emitted by deliberate
failure-path tests, so their count did not identify the cause.

A later full-suite run put a bounded diagnostic around the upload fixture. It
failed after 10 seconds while waiting for the initial commit WebSocket frame:

```text
DIAGNOSTIC frame upload=bd6fb342-1011-4d14-b0a8-8c0e4588da08 socket=1
```

Ready state 1 means that the client still considered the socket open. This
localises that occurrence to commit fixture setup. It does not prove that the
server deadlocked, because the same burst passed in isolation and the deadline
may have expired under full-suite load.

The investigation did establish three harness faults which turn a delayed
fixture into an uninformative, long failure:

1. The affected maintenance tests opened six or eight independent commit
   sessions at once. Commit concurrency was unrelated to the maintenance
   behaviour they asserted, and each commit also armed automatic alarm work.
2. `completeCommitSession` closed its socket only along handled response paths.
   An error from frame parsing or verification bypassed every close call.
3. Teardown removed previously selected Durable Objects from its registry after
   clearing their alarms. The following stalled-pass audit could inspect only
   the current object and the fixture object.

## Maintained invariants

Maintenance fixtures that need many committed rows create them serially with
automatic alarm arming fenced. Each commit session closes before the next one
opens. Tests that cover concurrent pushes keep their concurrency because it is
part of the behaviour those tests assert.

`completeCommitSession` closes its socket in a `finally` block. Its initial
frame and verdict waits each have a 20-second diagnostic deadline, which leaves
time inside Vitest's default 30-second case timeout for socket cleanup and the
shared teardown audit. A timeout reports the phase, upload ID, server name,
socket state, queued frame count, and pending reader count. The affected
maintenance cases use the default case timeout instead of 120-second or
240-second overrides. Verification remains under the case timeout because its
storage work cannot be cancelled safely while teardown begins.

The shared `afterEach` takes one snapshot of every Durable Object selected by a
test. It clears alarms and then checks retry deadlines on every object in that
same snapshot. A future retry deadline fails the test with the maintenance pass
and remaining wait time.

If another timing failure occurs, use the reported commit phase and conversation
state first. Treat `workerd` alarm and exception output as supporting evidence
only after the output is tied to the failing test and object.

Ten consecutive runs of the six affected test files completed under the default
case timeout after these changes. All 330 test executions passed, and each run
finished in 10.76 to 15.01 seconds.
