import { useState } from "react";
import type { Meeting, ShareGrant, ShareLayer, SharePermission, User } from "@collective/shared";
import { ApiError, deleteShare, postShare } from "../api";
import { Avatar } from "./Avatar";
import { Modal } from "./Modal";

interface RowSpec {
  layer: ShareLayer;
  label: string;
  hint: string;
  allowEdit: boolean;
}

/** Per-layer rows, defaults most-restricted (spec §7.3.4): nothing pre-shared. */
const ROWS: RowSpec[] = [
  {
    layer: "summary",
    label: "Overview",
    hint: "The meeting record: title, date, attendees. Recipients' access is logged.",
    allowEdit: true,
  },
  {
    layer: "notes",
    label: "Your notes",
    hint: "Your private notes never ride along silently — share them only on purpose.",
    allowEdit: false,
  },
  {
    layer: "transcript",
    label: "Transcript",
    hint: "Transcripts may contain patient information. Recipients' access is logged.",
    allowEdit: false,
  },
  {
    layer: "audio",
    label: "Audio",
    hint: "The raw recording. Sharing audio needs an admin policy allowance.",
    allowEdit: false,
  },
];

function ShareRow({
  spec,
  meeting,
  candidates,
  onGranted,
}: {
  spec: RowSpec;
  meeting: Meeting;
  candidates: User[];
  onGranted: (g: ShareGrant) => void;
}) {
  const [granteeUserId, setGranteeUserId] = useState("");
  const [permission, setPermission] = useState<SharePermission>("view");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const selectId = `share-${spec.layer}-who`;
  const permId = `share-${spec.layer}-perm`;

  const grant = async () => {
    if (!granteeUserId) return;
    setBusy(true);
    setError(null);
    try {
      const g = await postShare(meeting.id, { layer: spec.layer, granteeUserId, permission });
      onGranted(g);
      setGranteeUserId("");
    } catch (err) {
      if (err instanceof ApiError && err.status === 403)
        setError(
          spec.layer === "audio"
            ? "Audio sharing is off for this org — an admin has to allow it first."
            : "You can't share this layer.",
        );
      else setError("Sharing failed. Try again.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="share-row">
      <div className="share-row-head">
        <span className="share-row-label">{spec.label}</span>
      </div>
      <p className="share-row-hint">{spec.hint}</p>
      <div className="share-row-controls">
        <label className="visually-hidden" htmlFor={selectId}>
          Share {spec.label} with
        </label>
        <select
          id={selectId}
          value={granteeUserId}
          onChange={(e) => setGranteeUserId(e.target.value)}
        >
          <option value="">Choose a person…</option>
          {candidates.map((u) => (
            <option key={u.id} value={u.id}>
              {u.displayName}
            </option>
          ))}
        </select>
        {spec.allowEdit && (
          <>
            <label className="visually-hidden" htmlFor={permId}>
              Permission for {spec.label}
            </label>
            <select
              id={permId}
              value={permission}
              onChange={(e) => setPermission(e.target.value as SharePermission)}
            >
              <option value="view">Can view</option>
              <option value="edit">Can edit</option>
            </select>
          </>
        )}
        <button type="button" className="btn" onClick={() => void grant()} disabled={!granteeUserId || busy}>
          Share {spec.layer}
        </button>
      </div>
      {error && (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}

/** Sharing sheet (spec §7.3.4): per-layer grants + who-has-access with revoke. */
export function ShareSheet({
  meeting,
  users,
  currentUserId,
  grants,
  onGrantsChange,
  onClose,
}: {
  meeting: Meeting;
  users: User[];
  currentUserId: string;
  grants: ShareGrant[];
  onGrantsChange: (next: ShareGrant[]) => void;
  onClose: () => void;
}) {
  const byId = new Map(users.map((u) => [u.id, u]));
  const candidates = users.filter((u) => u.id !== currentUserId && !u.deactivated);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const revoke = async (g: ShareGrant) => {
    setRevokeError(null);
    try {
      await deleteShare(g.id);
      onGrantsChange(grants.filter((x) => x.id !== g.id));
    } catch {
      setRevokeError("Revoking failed. Try again.");
    }
  };

  return (
    <Modal title="Share this meeting" onClose={onClose} wide>
      <p className="share-lede">
        Nothing is shared until you share it. Each layer is separate, and every grant is
        audit-logged.
      </p>
      {ROWS.map((spec) => (
        <ShareRow
          key={spec.layer}
          spec={spec}
          meeting={meeting}
          candidates={candidates}
          onGranted={(g) => onGrantsChange([...grants, g])}
        />
      ))}
      <div className="share-access">
        <h3 className="section-label">Who has access</h3>
        {grants.length === 0 ? (
          <p className="share-row-hint">Only you. No one else has been given access this session.</p>
        ) : (
          <ul className="share-access-list">
            {grants.map((g) => {
              const grantee = byId.get(g.granteeUserId);
              return (
                <li key={g.id} className="share-access-item">
                  <Avatar user={grantee} name={grantee?.displayName ?? g.granteeUserId} />
                  <span className="share-access-name">
                    {grantee?.displayName ?? g.granteeUserId}
                  </span>
                  <span className="share-access-meta mono">
                    {g.layer} · {g.permission}
                  </span>
                  <button type="button" className="btn-quiet" onClick={() => void revoke(g)}>
                    Revoke
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {revokeError && (
          <p className="field-error" role="alert">
            {revokeError}
          </p>
        )}
      </div>
    </Modal>
  );
}
