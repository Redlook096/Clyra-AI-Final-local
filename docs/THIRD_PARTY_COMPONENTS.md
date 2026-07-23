# Third-party component policy

Clyra uses upstream projects as narrowly scoped references. Before a component
or model is shipped, its licence, transitive dependencies, platform support,
memory profile, data path, and update posture must be recorded in
`THIRD_PARTY_NOTICES.md`. Optional analysis adapters must be lazy loaded and
must not run concurrently with transcription or final rendering on low-memory
machines.
