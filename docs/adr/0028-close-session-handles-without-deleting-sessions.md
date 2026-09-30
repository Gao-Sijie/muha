# Close live Session handles without deleting native Sessions

Closing an Agent Session through Muha interrupts any active Turn, releases the current live handle and its runtime resources, and makes that handle unusable, but never deletes the Coding Harness's persisted conversation or Muha's Native Event Records. Runtime closure applies the same operation to every open Session, and V0.1 exposes no portable native-session deletion operation, so a closed conversation remains resumable through its Session Reference.
