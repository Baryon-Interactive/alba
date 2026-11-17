# Order template: Code (`code`)

## Acceptance

- Typecheck exits 0 with no new warnings or suppressions.
- New and touched tests drive the changed code through its real entry point, assert on its result, and exit 0.

## Evidence

- artifacts/{tag_lower}/test.log: output of the typecheck and the new and touched test runs

## Paths

- allow: src/**
- allow: test/**

## Standing rules

- Tests must fail when the changed behaviour is broken; do not read `.ts` source in a test or weaken product logic to pass.
- Use temporary directories and port 0 in tests; stop any child process started by a test before finishing.
