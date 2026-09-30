# Share one error model across delivery channels

Muha distinguishes Command Rejection from Turn Failure without maintaining two error taxonomies: an unaccepted API command throws or rejects with a mechanical `MuhaError` wrapper, while an accepted Turn always resolves its terminal `TurnResult`, and both carry the same closed, JSON-safe `MuhaErrorData` union. A rejected control command does not itself determine the active Turn's terminal state, raw native exceptions and stacks remain private, and no public code or field is defined separately on the wrapper.
