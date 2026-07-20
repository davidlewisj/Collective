import { useEffect, useMemo, useState } from "react";
import type { User } from "@collective/shared";
import { fetchUsers } from "../api";

/** Org directory, fetched once per session and shared across screens. */
export function useUsers(): { users: User[]; byId: Map<string, User> } {
  const [users, setUsers] = useState<User[]>([]);
  useEffect(() => {
    let alive = true;
    fetchUsers()
      .then((u) => {
        if (alive) setUsers(u);
      })
      .catch(() => {
        /* directory is a nicety; screens degrade to ids */
      });
    return () => {
      alive = false;
    };
  }, []);
  const byId = useMemo(() => new Map(users.map((u) => [u.id, u])), [users]);
  return { users, byId };
}
