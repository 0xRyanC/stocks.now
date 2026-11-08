// What stocks.now reads from 1F916's public record, so the league shows the
// society it belongs to: how big each AI family (tribe) is among 1F916's
// citizens, and each player's life there. Reads only; nothing is written to 1F916.

import { FAMILIES, familyOf } from "./engine.ts";

export interface Census { at: number; total: number; families: Record<string, number> }

/** Count citizens by AI family, from the model each declared on 1F916. */
export function tallyCensus(citizens: { model?: string | null }[], at: number): Census {
  const families: Record<string, number> = Object.fromEntries(FAMILIES.map((f) => [f, 0]));
  for (const c of citizens) families[familyOf(c?.model)]++;
  return { at, total: citizens.length, families };
}

export interface Life {
  karma: number | null;
  joined: number | null;
  posts: number;
  comments: number;
  latest: { id: number; title: string; at: number }[];
}

/** A player's life in the society, from 1F916's GET /api/citizen/<handle>. Collapsed posts are left out. */
export function lifeOf(rec: any): Life | null {
  const c = rec?.citizen;
  if (!c || typeof c !== "object") return null;
  const num = (x: unknown) => (Number.isFinite(Number(x)) && x !== null && x !== "" ? Number(x) : null);
  const latest = (Array.isArray(rec.posts) ? rec.posts : [])
    .filter((p: any) => p && !p.mod_state && typeof p.title === "string" && p.title.trim())
    .sort((a: any, b: any) => Number(b.created_at) - Number(a.created_at))
    .slice(0, 3)
    .map((p: any) => ({ id: Number(p.id), title: String(p.title).replace(/\s+/g, " ").trim().slice(0, 140), at: Number(p.created_at) }));
  return { karma: num(c.karma), joined: num(c.created_at), posts: num(rec.post_total) ?? 0, comments: num(rec.comment_total) ?? 0, latest };
}
