---
title: "Production-Grade Multi-Tenant RAG WhatsApp Bot on Oracle Free Tier"
description: "Engineer a fully self-hosted, multi-tenant AI assistant for WhatsApp with isolated data and semantic search."
heroImage: "../src/assets/images/whatsapp-rag-banner.png"
---

# Building a Production-Grade Multi-Tenant RAG WhatsApp Bot on Oracle Free Tier

## The Challenge: Zero Budget, Enterprise-Grade Architecture

Most chatbot tutorials show you how to connect two SaaS platforms and call it a day. This project was different — the goal was to engineer a fully self-hosted, multi-tenant AI assistant for WhatsApp that could serve 100+ clients with isolated data, semantic search, and intelligent guardrails, running entirely on Oracle Cloud's free ARM64 instance.

The constraints were real: 50GB shared disk, no managed databases, no paid proxies, and a LiteSpeed web server that had opinions of its own.

---

## Phase 1: Taming LiteSpeed — The WebSocket Compression Problem

**The Problem:** After deploying n8n behind LiteSpeed via CyberPanel, the editor loaded fine — but executing any workflow caused an immediate crash. The logs revealed: `Invalid WebSocket frame: RSV1 must be clear`. LiteSpeed was silently injecting `permessage-deflate` compression into WebSocket frames, corrupting them before they reached n8n.

**The Solution:** Disabling gzip at the VHost level (`enableGzip 0`, `enableBr 0`) wasn't enough — LiteSpeed was negotiating compression at the WebSocket handshake layer independently. The fix required switching n8n's push backend from WebSocket to SSE (`N8N_PUSH_BACKEND=sse`) and introducing an nginx sidecar container that forced the correct headers before traffic reached n8n.

**The Insight:** Reverse proxies don't just route traffic — they actively transform it. When a proxy sits between a WebSocket server and a client, every header, every extension negotiation, every frame bit becomes a potential point of failure.

---

## Phase 2: The Origin Header Mystery

**The Problem:** After switching to SSE, a new error appeared: `Origin header does NOT match the expected origin. Expected: "undefined"`. n8n's security layer was rejecting all push connections because it couldn't determine its own origin — rendering the editor unusable for workflow execution.

**The Deep Dive:** Using `tcpdump` on the loopback interface confirmed the `Origin` header was arriving correctly at port 5678. The real issue was a nested directory problem: `N8N_USER_FOLDER` and `HOME` environment variables were compounding, creating a `~/.n8n/.n8n/config` path that n8n never read. The `editorBaseUrl` was never loaded, so n8n's expected origin was literally `undefined`.

**The Solution:** Remapping the Docker volume directly to `/home/node/.n8n` — n8n's canonical default path — and removing the conflicting `HOME` variable. The nginx sidecar injected `Origin: https://n8n.domain.com` as a static header, bypassing the proxy stripping entirely.

**The Insight:** Container path nesting is a silent killer. When `HOME` and a custom folder variable both resolve to the same base, you get infinite directory recursion that no error message will explain clearly.

---

## Phase 3: Python in a Distroless Container

**The Problem:** n8n's latest image is distroless — no shell, no package manager, no Python. Enabling the Python task runner returned: `Virtual environment is missing from this system`. Standard approaches (copying Alpine binaries, using glibc builds) failed due to library incompatibilities on ARM64.

**The Deep Dive:** By reading n8n's compiled source (`task-runner-process-py.js`), the exact expected venv path was located: `/usr/local/lib/node_modules/@n8n/task-runner-python/.venv/bin/python`. The `src/` directory containing the runner's Python code wasn't in the distroless image at all — it had to be cloned from the n8n GitHub repository at the matching version tag.

**The Solution:** A three-stage Dockerfile — Alpine Python builder for the venv, Node.js for cloning the runner source, and the n8n distroless base as the final stage. Libraries like `libpython3.12.so` and `libffi.so.8` were copied individually with proper symlinks.

**The Insight:** Distroless images are secure by design — but that security means you must understand exactly what your dependencies need at the binary level, not just the package level.

---

## Phase 4: Building the RAG Pipeline

**The Architecture:**
```
PDF/CSV Upload → Python Extraction → Word-aware Chunking → 
OpenAI Embeddings (batch) → Upstash Vector → PostgreSQL Control Table
```

**Key Engineering Decisions:**

**File extraction without base64:** n8n stores uploaded files as `filesystem-v2` references, not in-memory base64. The Python node reads directly from `/home/node/.n8n/binaryData/` using the UUID from the file reference — bypassing the broken base64 pipeline entirely.

**Word-aware chunking:** Character-based chunking with overlap produced fragments like `"ico."` — the tail end of a word split across boundaries. Switching to word-boundary chunking with a minimum chunk size filter (50 chars) eliminated orphaned fragments entirely.

**SHA-256 deduplication:** Each uploaded file is hashed before processing. A PostgreSQL control table (`rag_files`) stores the hash per `instance_id + filename`. On re-upload, if the hash matches, the entire embedding pipeline is skipped — zero wasted API calls.

**Batch upsert to Upstash:** 1536-dimension vectors at 20 vectors per request exceeded Upstash's payload limit. The JavaScript node batches into groups of 5, sending the array as raw JSON body — `Using Fields Below` mode wraps the payload in an extra object that Upstash rejects.

**The Insight:** Vector databases have strict payload size limits that aren't always documented clearly. Always calculate your payload size (`dimensions × 4 bytes × batch_size`) before assuming a batch size is safe.

---

## Phase 5: Multi-Tenant Query Pipeline

**The Architecture:**
```
WhatsApp Message → Embed Query → Upstash Semantic Search (filter: instance_id) → 
Context Injection → AI Agent → Response
```

Each client's vectors are tagged with `instance_id` in metadata. Upstash's SQL-like filter syntax (`"filter": "instance_id = 'PixelPages_Prueba'"`) ensures complete data isolation at query time — one index, 100 clients, zero cross-contamination.

The system prompt template in Airtable uses `{{ $json.variable }}` placeholders that a JavaScript node resolves before passing to the AI Agent — making the entire agent persona, RAG context, and business rules configurable per client without touching the workflow.

---

## Phase 6: WhatsApp Media Decryption

**The Problem:** WhatsApp encrypts all media with AES-256. The `media_key` URL returned by Evolution API is an `.enc` file — unreadable without decryption. The Analyze Image node in n8n couldn't process base64 data URLs, and the OpenAI node's URL mode doesn't support data URLs either.

**The Solution:** Evolution API's `/chat/getBase64FromMediaMessage` endpoint handles decryption server-side, returning clean base64. A JavaScript node constructs the data URL (`data:${mimetype};base64,${clean_base64}`) and passes it directly to a raw OpenAI HTTP Request node — bypassing n8n's native node limitations entirely.

**For audio:** The base64 OGG is converted to a binary attachment in-memory within the n8n execution context, consumed by Whisper, and the transcription flows into the same RAG pipeline as text messages.

---

## Phase 7: Intelligent Guardrails

Four validation layers execute before any AI processing:

1. **Timestamp Guard:** Messages older than 4 hours are silently dropped — prevents Evolution API retry storms from flooding the pipeline when n8n restarts.

2. **Pause Guard:** A PostgreSQL table (`bot_pauses`) tracks per-conversation pause states. Users send `/pause 24` (embedded anywhere in a message) to silence the bot for N hours on their specific `remote_jid`. The command is detected via regex, stripped from the message, and the conversation continues transparently.

3. **Exclusion Guard:** Airtable stores excluded phone numbers per instance. A `FIND()` filter performs a contains-match on the last 10 digits of the `remote_jid` — making it country-code agnostic without hardcoding any country prefixes.

4. **Relevance Guard:** A `gpt-4o-mini` call (~$0.000007 per message) classifies whether the incoming message is relevant to the business context before triggering the full RAG pipeline. Irrelevant messages receive a polite deflection. Cost at 10,000 messages/month: ~$0.07.

---

## The Stack

| Layer | Technology | Cost |
|---|---|---|
| VPS | Oracle Cloud ARM64 (4 vCPU, 24GB RAM) | $0 |
| Orchestration | n8n (self-hosted Docker) | $0 |
| Web Server | LiteSpeed via CyberPanel | $0 |
| Reverse Proxy | nginx sidecar | $0 |
| Vector DB | Upstash Vector | $0 |
| Logs DB | Turso (per-tenant SQLite) | $4.99/mo |
| Config Store | Airtable | $0 |
| Control DB | PostgreSQL (self-hosted) | $0 |
| AI | OpenAI GPT-4o + Whisper + Embeddings | Usage |
| WhatsApp | Evolution API (self-hosted) | $0 |

**Total fixed infrastructure cost: ~$5/month for 100 clients.**

---

## Key Takeaways

- Self-hosting is not cheaper than managed services in time — but it builds understanding that managed services actively hide from you.
- Reading compiled JavaScript source code to find undocumented internal paths is a legitimate debugging strategy.
- Every proxy layer is a transformation layer. Treat it that way.
- The difference between a demo and a production system is the guardrails, not the AI model.
