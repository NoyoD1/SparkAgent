// Sidecar entrypoint — re-export the streaming logic
// (The actual IPC loop is in openai-compatible.mjs for now; this file is the canonical
// entrypoint that Rust spawns. Phase 3+: add other provider adapters here.)
import './openai-compatible.mjs';
