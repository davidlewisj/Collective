# Collective HTTP API v1 (dev slice)

Base: `http://localhost:4000`. JSON everywhere. Auth: `Authorization: Bearer <token>` from `POST /auth/dev-login` (dev mode; production is OIDC against Entra ID per spec §2.6.1 — issue ID-1/#11). Types in `@collective/shared`.

Every content read is audit-logged server-side. All list/detail responses are ACL-filtered — a caller never sees a meeting or layer they lack access to (spec §2.6.1, §2.7.2).

| Method & path | Body → Response | Notes |
|---|---|---|
| POST `/auth/dev-login` | `{email}` → `{token, user}` | Seeded users; 404 for unknown email |
| GET `/auth/config` | → `{microsoft}` | Which sign-in methods are configured |
| GET `/auth/microsoft` → `/auth/callback` | OAuth2 code flow (Entra ID, confidential client) | Links by email or auto-provisions as member; session token returned via `WEB_ORIGIN/login#msToken=`; Graph refresh token stored for calendar naming |
| PUT `/admin/users/:id/role` | `{role}` → `{user}` | org_admin; not on yourself; audit-logged |
| GET `/me` | → `{user}` | |
| GET `/users` | → `{users}` | Directory (id, displayName, role, speakerHue) for pickers |
| GET `/meetings` | `?q=&participant=` → `{meetings}` | Accessible meetings, newest first |
| POST `/meetings` | `{title?, mode, attendeeUserIds?}` → `{meeting}` | Creates `draft`; owner = caller |
| GET `/meetings/:id` | → `{meeting, myLayers}` | `myLayers`: which layers caller may read |
| POST `/meetings/:id/consent` | `{mechanism, detail?}` → `{meeting}` | Records a consent artifact |
| POST `/meetings/:id/start` | → `{meeting}` | **409 `consent_required`** until policy satisfied (spec §2.6.2) |
| POST `/meetings/:id/chunks` | `{seq, dataBase64}` → `{received}` | Audio chunk during recording |
| GET `/meetings/:id/live` | Server-Sent Events | `caption` events (live turns with cluster labels), `status` events (incl. `liveCaptions` flag) |
| WS `/meetings/:id/stream` | `?token=&rate=16000`; binary PCM16 frames up | Live-caption streaming relay → AssemblyAI v3 (owner only, while recording; §6.6-gated; token as query param because browser WS can't set headers) |
| POST `/meetings/:id/stop` | → `{meeting}` | → `processing`; pipeline: transcribe → attribute → insight; → `ready` |
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
| GET `/search` | `?q=` → `{hits}` | `{meetingId, title, snippet, layer}`; ACL + revocation aware |
| GET `/audit` | `?meetingId=&actor=` → `{events}` | `compliance_auditor`/`org_admin` only |
| GET `/me/settings` · PUT same | `{calendarIcsUrl}` → `{settings}` | Per-user; ICS feed powers calendar naming on untitled captures |
| GET `/me/calendar-preview` | → `{event}` or 404 | Settings "Test": what a capture started now would be named |
| GET/POST/DELETE `/me/connector-token` | POST → `{token}` (shown once, `mcp_…`) | Long-lived Claude connector token; authenticates **`/mcp` only**; mint replaces, delete revokes |
| GET `/admin/baa-registry` · PUT same | body `{assemblyai, awsBedrock, claudeWorkspace, microsoft}` → response `{baa}` | org_admin; drives §6.6 gating |
| GET `/admin/consent-policy` · PUT same | body `{requiredMechanisms, phiFailSafe}` → response `{policy}` | org_admin |
| GET `/admin/retention` · PUT same | body `{audioDays, transcriptDays, auditDays}` → response `{retention}` | org_admin |

**MCP server:** `POST /mcp` — Model Context Protocol (Streamable HTTP), same bearer auth, tools `search_meetings`, `list_meetings`, `get_meeting`, `get_transcript`, `get_action_items`. Results are ACL-filtered per caller and PHI-flag-gated per the BAA registry (spec §6.3, §6.6). No audio, no cross-user notes, no writes.

**§6.6 gating semantics (server-enforced):**
- Insight (summary) job: if `phiEffective(meeting)` and `!baa.awsBedrock` → job skipped, heuristic title, `ai.skippedReason` set.
- MCP tools: if `phiEffective(meeting)` and `!baa.claudeWorkspace` → meeting excluded from every result.
- `phiEffective` = `phiFlag === true`, or (`phiFlag === null` and `consentPolicy.phiFailSafe`).

**Dev seed users** (password-less dev login): `dana@collective.dev` (org_admin), `omar@collective.dev` (member), `priya@collective.dev` (member), `casey@collective.dev` (compliance_auditor).
