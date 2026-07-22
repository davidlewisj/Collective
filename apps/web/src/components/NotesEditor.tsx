import { useId } from "react";
import type { NoteSaveState } from "../lib/useNote";
import { IconCheck, IconChevronDown, IconLock, IconNotes, IconPlus } from "./icons";

const SAVE_LABEL: Record<NoteSaveState, string> = {
  idle: "",
  dirty: "Unsaved…",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save — retrying on next edit",
};

/**
 * Low-friction private-notes editor with an integrated header (icon, the
 * "Only you" lock, save state). Optionally collapsible into a one-line
 * header + preview, expanding smoothly on demand.
 */
export function NotesEditor({
  body,
  onChange,
  saveState,
  rows = 10,
  collapsible = false,
  open = true,
  onToggle,
  onInsertMark,
}: {
  body: string;
  onChange: (next: string) => void;
  saveState: NoteSaveState;
  rows?: number;
  collapsible?: boolean;
  open?: boolean;
  onToggle?: () => void;
  onInsertMark?: () => void;
}) {
  const id = useId();
  const expanded = !collapsible || open;
  return (
    <div className={`notes-editor${collapsible ? " notes-collapsible" : ""}${expanded ? " notes-open" : ""}`}>
      <div className="notes-head">
        <span className="notes-head-title">
          <IconNotes size={18} />
          <span className="section-label notes-head-label">My notes</span>
          <span className="only-you-badge" title="Private notes. Nobody else can read these unless you share them.">
            <IconLock size={13} />
            Only you
          </span>
        </span>
        <span className="notes-head-tail">
          <span className={`notes-save notes-save-${saveState}`} aria-live="polite">
            {saveState === "saved" && <IconCheck size={14} />}
            {SAVE_LABEL[saveState]}
          </span>
          {onInsertMark && (
            <button type="button" className="notes-mark-btn icon-text-btn" onClick={onInsertMark} title="Insert a timestamp mark">
              <IconPlus size={16} />
              Mark
            </button>
          )}
          {collapsible && (
            <button
              type="button"
              className="notes-chevron"
              aria-expanded={expanded}
              aria-label={expanded ? "Collapse notes" : "Expand notes"}
              onClick={onToggle}
            >
              <IconChevronDown size={20} />
            </button>
          )}
        </span>
      </div>

      {collapsible && !expanded && (
        <button type="button" className="notes-preview" onClick={onToggle}>
          {body.trim() ? body.trim() : "Add a note…"}
        </button>
      )}

      <div className="notes-body">
        {/* Inner wrapper is the grid child: a textarea won't shrink below one
            row, so the collapse animates this div (clean 0fr) instead. */}
        <div className="notes-body-inner">
          <textarea
            id={id}
            className="notes-textarea"
            value={body}
            rows={rows}
            placeholder="Type your private notes…"
            onChange={(e) => onChange(e.target.value)}
            tabIndex={expanded ? undefined : -1}
            aria-hidden={expanded ? undefined : true}
          />
        </div>
      </div>
    </div>
  );
}
