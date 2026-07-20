import { useId } from "react";
import type { NoteSaveState } from "../lib/useNote";

const SAVE_LABEL: Record<NoteSaveState, string> = {
  idle: "",
  dirty: "Unsaved…",
  saving: "Saving…",
  saved: "Saved",
  error: "Couldn't save — retrying on next edit",
};

/** Plain low-friction notes editor with the "Only you" privacy badge. */
export function NotesEditor({
  body,
  onChange,
  saveState,
  rows = 10,
}: {
  body: string;
  onChange: (next: string) => void;
  saveState: NoteSaveState;
  rows?: number;
}) {
  const id = useId();
  return (
    <div className="notes-editor">
      <div className="notes-head">
        <label htmlFor={id} className="section-label">
          My notes
        </label>
        <span className="only-you-badge" title="Private notes. Nobody else can read these unless you share them.">
          Only you
        </span>
        <span className={`notes-save notes-save-${saveState}`} aria-live="polite">
          {SAVE_LABEL[saveState]}
        </span>
      </div>
      <textarea
        id={id}
        className="notes-textarea"
        value={body}
        rows={rows}
        placeholder="Type your private notes…"
        onChange={(e) => onChange(e.target.value)}
      />
    </div>
  );
}
