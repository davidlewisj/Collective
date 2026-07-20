import { useCallback, useEffect, useRef, useState } from "react";
import { getNote, putNote } from "../api";

export type NoteSaveState = "idle" | "dirty" | "saving" | "saved" | "error";

/** Private-notes editor state with debounced autosave (800 ms). */
export function useNote(meetingId: string | null): {
  body: string;
  setBody: (next: string) => void;
  appendLine: (line: string) => void;
  saveState: NoteSaveState;
  loaded: boolean;
} {
  const [body, setBodyState] = useState("");
  const [saveState, setSaveState] = useState<NoteSaveState>("idle");
  const [loaded, setLoaded] = useState(false);
  const timer = useRef<number | null>(null);
  const latest = useRef("");

  useEffect(() => {
    setBodyState("");
    latest.current = "";
    setLoaded(false);
    setSaveState("idle");
    if (!meetingId) return;
    let alive = true;
    getNote(meetingId)
      .then((note) => {
        if (!alive) return;
        setBodyState(note?.body ?? "");
        latest.current = note?.body ?? "";
        setLoaded(true);
      })
      .catch(() => {
        if (alive) setLoaded(true);
      });
    return () => {
      alive = false;
    };
  }, [meetingId]);

  const scheduleSave = useCallback(() => {
    if (!meetingId) return;
    if (timer.current !== null) window.clearTimeout(timer.current);
    setSaveState("dirty");
    timer.current = window.setTimeout(() => {
      setSaveState("saving");
      putNote(meetingId, latest.current)
        .then(() => setSaveState("saved"))
        .catch(() => setSaveState("error"));
    }, 800);
  }, [meetingId]);

  const setBody = useCallback(
    (next: string) => {
      latest.current = next;
      setBodyState(next);
      scheduleSave();
    },
    [scheduleSave],
  );

  const appendLine = useCallback(
    (line: string) => {
      const cur = latest.current;
      const next = cur.length === 0 || cur.endsWith("\n") ? cur + line + "\n" : cur + "\n" + line + "\n";
      setBody(next);
    },
    [setBody],
  );

  useEffect(
    () => () => {
      if (timer.current !== null) window.clearTimeout(timer.current);
    },
    [],
  );

  return { body, setBody, appendLine, saveState, loaded };
}
