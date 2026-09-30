# Allow one live Runtime per main process

Muha Runtime remains an explicitly created root resource, but each Node.js main process may have at most one live instance and Worker Threads may not create one. Closing or failed initialization releases the process-global guard; separate processes may each create a Runtime, while an exclusive data-directory lease prevents them from opening the same Diagnostic Event Store, and no global Runtime accessor is exposed.
