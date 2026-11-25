# Task: Shell Safety and Path Boundary Guard

Implement `src/path-command-guard.mjs`, a zero-dependency module that validates file paths and shell-like command requests before a host tool may execute them.

## Required behavior

Export `assertSafePath(root, candidate)` and `inspectShellCommand(command)`.

- `assertSafePath` resolves `candidate` inside `root`, rejects `..` escapes, absolute paths outside root, NUL bytes, empty input, and symlink escapes when the path exists.
- `inspectShellCommand` returns `{ decision: 'allow' }` only for a narrow development allowlist such as `npm test`, `node --test`, and `git status`.
- It returns `{ decision: 'deny', reason }` for destructive file operations, force pushes, shell wrapper evasion, command substitution, pipes into shells, SQL destruction, cloud resource deletion, and empty or non-string commands.
- The module must fail closed on parser uncertainty.

Add `src/path-command-guard.test.mjs` covering traversal, symlink behavior, allowed commands, and wrapper evasion. Do not execute any inspected command in the tests.
