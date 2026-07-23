# Collective HTTP API v1 (dev slice)

Base: `http://localhost:4000`. JSON everywhere. Auth: `Authorization: Bearer <token>` from `POST /auth/dev-login` (dev mode; production is OIDC against Entra ID per spec §2.6.1 — issue ID-1/#11). Types in `@collective/shared`.

Every content read is audit-logged server-side. All list/detail responses are ACL-filtered — a caller never sees a meeting or layer they lack access to (spec §2.6.1, §2.7.2).

| Method & path | Body → Response | Notes |
|---|---|---|
| POST `/auth/dev-login` | `{email}` → `{token, user}` | Seeded users; 404 for unknown email; **403 when dev-login is disabled** (public deploys — D17). Seeding itself only runs where dev-login is allowed |
| GET `/auth/config` | → `{microsoft, devLogin}` | Which sign-in methods are configured; `devLogin` gates the web login form's passwordless affordance |
| GET `/auth/microsoft` → `/auth/callback` | OAuth2 code flow (Entra ID, confidential client) | id_token verified (RS256 signature against the tenant JWKS, then iss/aud/exp); matches a returning user by the immutable Entra `oid` (renamed mailbox stays the same account; a reused email can't inherit a prior account), links by email only on a first sign-in to a pre-existing row, else provisions into the single org (§8.1 D18). The `COLLECTIVE_BOOTSTRAP_ADMIN` email is provisioned/promoted to an **active `org_admin`**; every other new account joins **`pending`**. Session token returned via `WEB_ORIGIN/login#msToken=`; Graph refresh token stored for calendar naming |
| PUT `/admin/users/:id/role` | `{role}` → `{user}` | org_admin; not on yourself (400); **refuses to demote the last active org_admin (409)**; audit-logged |
| GET `/me` | → `{user}` | `user.status` is `active` or `pending`; the **only** route a pending member may call (everything else 403s until approved) |
| GET `/users` | → `{users}` | Directory (id, displayName, role, speakerHue, bubbleHue) for pickers; **active members only** — pending (unapproved) and deactivated accounts are excluded |
| GET `/admin/members` | → `{members:[{id, email, displayName, role, status, deactivated}]}` | org_admin; full org directory, **pending first** (join requests), then active alphabetical |
| POST `/admin/members/:id/approve` | → `{member}` | org_admin; `pending → active` (409 if not pending); audited `admin.member_approved` |
| POST `/admin/members/:id/deny` | → `{ok}` | org_admin; deletes the unapproved account and revokes its sessions (409 if not pending); audited `admin.member_denied` |
| POST `/admin/members/:id/deactivate` | → `{member}` | org_admin; off-board an **active** member — soft-deactivates (record/notes/meetings/audit preserved) and revokes sessions. 409 if not active, already deactivated, or the **last active org_admin**; audited `admin.member_deactivated` |
| POST `/admin/members/:id/reactivate` | → `{member}` | org_admin; restores a deactivated member (409 if not deactivated); audited `admin.member_reactivated` |
| GET `/meetings` | `?q=&participant=` → `{meetings}` | Accessible meetings, newest first |
| POST `/meetings` | `{title?, mode, attendeeUserIds?}` → `{meeting}` | Creates `draft`; owner = caller |
| GET `/meetings/:id` | → `{meeting, myLayers}` | `myLayers`: which layers caller may read |
| POST `/meetings/:id/consent` | `{mechanism, detail?}` → `{meeting}` | Records a consent artifact |
| POST `/meetings/:id/start` | → `{meeting}` | **409 `consent_required`** until policy satisfied (spec §2.6.2) |
| POST `/meetings/:id/chunks` | `{seq, dataBase64}` → `{received}` | Audio chunk during recording |
| GET `/meetings/:id/live` | Server-Sent Events | `caption` events (live turns with cluster labels), `status` events (incl. `liveCaptions` flag), `speakers` events (cluster→name map from in-session naming) |
| POST `/meetings/:id/live/speaker` | `{cluster, userId?\|guestLabel?}` → `{speakers}` | Owner, while recording: name a live voice in real time; carries into the final transcript as manual attribution (live↔batch clusters matched by text overlap) |
| POST `/meetings/:id/flags` | `{atMs, label?}` → `{flag, meeting}` | Owner, while recording: flag a moment (ms from start); renders as a labeled divider in the live + finished transcript. Audited `meeting.flagged` |
| WS `/meetings/:id/stream` | `?token=&rate=16000`; binary PCM16 frames up | Live-caption streaming relay → AssemblyAI v3 (owner only, while recording; §6.6-gated; token as query param because browser WS can't set headers) |
| POST `/meetings/:id/stop` | → `{meeting}` | → `processing`; pipeline: transcribe → attribute (incl. live-assigned names); → `ready`. No summary job — summaries are asked of Claude via the connector (D10) |
| POST `/meetings/:id/objection` | → `{meeting}` | Stops + deletes audio, keeps notes (spec §2.6.2 objection path) |
| GET `/meetings/:id/transcript` | → `{utterances}` | Requires transcript access |
| POST `/meetings/:id/utterances/:uid/speaker` | `{userId?|guestLabel?, scope: "line"\|"voice"}` → `{utterances}` | Manual correction; audit-logged |
| PUT `/meetings/:id/phi-flag` | `{flagged: boolean\|null}` → `{meeting}` | Facilitator/owner only (spec §6.6) |
| GET `/meetings/:id/notes` | → `{note}` | Caller's own note only, always |
| PUT `/meetings/:id/notes` | `{body}` → `{note}` | |
| GET `/meetings/:id/audio` | → 200 audio/stub or **403** | Distinct `audio` permission; every call audited |
| POST `/meetings/:id/shares` | `{layer, granteeUserId, permission}` → `{share}` | Owner only; audio layer requires admin policy |
| DELETE `/shares/:shareId` | → `{ok}` | Revocation is immediate incl. search |
| POST `/memos` | `{dataBase64}` → `{text}` | Voice memo via Sync path (≤120 s) |
| GET `/search` | `?q=` → `{hits}` | `{meetingId, title, snippet, layer, whenIso}`; ACL + revocation aware; `whenIso` lets results show the meeting date |
| GET `/audit` | `?meetingId=&actor=` → `{events}` | `compliance_auditor`/`org_admin` only |
| GET `/me/settings` · PUT same | `{calendarIcsUrl}` → `{settings}` | Per-user; ICS feed powers calendar naming on untitled captures |
| GET `/me/calendar-preview` | → `{event}` or 404 | Settings "Test": what a capture started now would be named |
| GET `/me/calendar-upcoming` | → `{events:[{title, startMs, endMs, attendeeEmails, joinUrl, joinProvider}]}` | "Coming up" list: not-yet-ended ICS events, soonest first; `joinProvider` ∈ teams\|zoom\|meet when a link is detected. Empty when no feed |
| GET/POST/DELETE `/me/connector-token` | POST → `{token}` (shown once, `mcp_…`) | Long-lived Claude connector token; authenticates **`/mcp` only**; mint replaces, delete revokes |
| GET/POST/DELETE `/me/voiceprint` | POST `{audioBase64, consent:true}` → `{enrolled, createdAt, vendor}` | Self-only voice enrollment (spec §2.3.3). Biometric: explicit consent required; a real vendor is gated on the `voice` BAA; embedding never logged. DELETE removes it. Enables `voice_profile` attribution |
| GET `/admin/baa-registry` · PUT same | body `{assemblyai, claudeWorkspace, microsoft, voice}` → response `{baa}` | org_admin; drives §6.6 + voiceprint egress gating |
| GET `/admin/consent-policy` · PUT same | body `{requiredMechanisms, phiFailSafe}` → response `{policy}` | org_admin |
| GET `/admin/retention` · PUT same | body `{audioDays, transcriptDays, auditDays}` → response `{retention}` | org_admin |

**MCP server:** `POST /mcp` — Model Context Protocol (Streamable HTTP), tools `search_meetings`, `list_meetings`, `get_meeting`, `get_transcript`, `get_notes` (caller's own note only). Post-D10 this is THE summary/Q&A surface: Claude reads the transcript + the caller's notes and produces summaries/action items on demand. Results are ACL-filtered per caller and PHI-flag-gated per the BAA registry (spec §6.3, §6.6). No audio, no cross-user notes, no writes. Accepts three credentials: an OAuth 2.1 access token (below), a long-lived connector token (`mcp_…`), or a normal session bearer. An unauthenticated request gets **401** with `WWW-Authenticate: Bearer resource_metadata="…"` (RFC 9728). Each tool is gated on a scope (`search_meetings`→`meetings.search`, `get_transcript`→`transcripts.read`, the rest→`meetings.read`).

**MCP OAuth 2.1 (spec §6.4 — claude.ai custom connector):** the server is the authorization + resource server for `/mcp`. Dynamic client registration is disabled; an org_admin mints an allowlisted client and enters its id/secret into Claude.

| Method & path | Body → Response | Notes |
|---|---|---|
| GET `/.well-known/oauth-protected-resource[/mcp]` | → RFC 9728 metadata | `{resource, authorization_servers, scopes_supported, bearer_methods_supported}` |
| GET `/.well-known/oauth-authorization-server[/mcp]` | → RFC 8414 metadata | `authorization_endpoint`, `token_endpoint`, `code_challenge_methods_supported:["S256"]`; no `registration_endpoint` |
| GET `/oauth/authorize` | `?response_type=code&client_id&redirect_uri&code_challenge&code_challenge_method=S256&scope&state&resource` | Validates client/redirect/PKCE/resource (RFC 8707), then 302 → `WEB_ORIGIN/connect?rid=…`; bad client/redirect renders an error page, never bounces |
| GET `/oauth/authorize/info` | `?rid` → `{clientName, scopes, resource}` | Consent-page data (rid unguessable + short-lived) |
| POST `/oauth/authorize/decision` | `{rid, approve}` → `{redirectTo}` | **Requires the signed-in user**; code is minted under *their* identity |
| POST `/oauth/token` | form: `authorization_code` (code, redirect_uri, code_verifier, client_id/secret) or `refresh_token` → token set | PKCE-verified; audience-bound to the MCP resource; refresh rotates |
| GET/POST/DELETE `/admin/oauth-clients[/:id]` | POST `{name, redirectUris}` → `{client, clientSecret}` (secret shown once) | org_admin; the allowlist; DELETE revokes the client and its tokens |

**§6.6 gating semantics (server-enforced):**
- Real-vendor transcription: if `phiEffective(meeting)` and `!baa.assemblyai` → audio never leaves; `meeting.notice` explains; reprocess after the registry flips.
- MCP tools: if `phiEffective(meeting)` and `!baa.claudeWorkspace` → meeting excluded from every result.
- `phiEffective` = `phiFlag === true`, or (`phiFlag === null` and `consentPolicy.phiFailSafe`).

**Dev seed users** (password-less dev login): `dana@collective.dev` (org_admin), `omar@collective.dev` (member), `priya@collective.dev` (member), `casey@collective.dev` (compliance_auditor).
