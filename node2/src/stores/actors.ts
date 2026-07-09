/**
 * Multi-actor session store for horizontal/vertical privilege testing.
 * Actors hold independent auth headers (Bearer, Cookie, custom) so the agent
 * can switch identity without overwriting a single global snapshot.
 */

export type ActorRecord = {
  id: string;
  label: string;
  roleHint?: string;
  headers: Record<string, string>;
  meta: Record<string, unknown>;
  updatedAt: string;
};

export type ActorUpsertInput = {
  id: string;
  label?: string;
  role_hint?: string;
  roleHint?: string;
  headers?: Record<string, string>;
  authorization?: string;
  cookie?: string;
  meta?: Record<string, unknown>;
  /** When true, replace headers entirely instead of merging. */
  replace_headers?: boolean;
};

export class ActorStore {
  private readonly actors = new Map<string, ActorRecord>();
  private activeId: string | undefined;

  list(): ActorRecord[] {
    return [...this.actors.values()].sort((a, b) => a.id.localeCompare(b.id));
  }

  count(): number {
    return this.actors.size;
  }

  get(id: string): ActorRecord | undefined {
    return this.actors.get(id);
  }

  active(): ActorRecord | undefined {
    return this.activeId ? this.actors.get(this.activeId) : undefined;
  }

  activeIdValue(): string | undefined {
    return this.activeId;
  }

  upsert(input: ActorUpsertInput): ActorRecord {
    const id = String(input.id || "").trim();
    if (!id) throw new Error("actor id is required");
    const existing = this.actors.get(id);
    const headers = input.replace_headers ? {} : { ...(existing?.headers || {}) };
    for (const [key, value] of Object.entries(input.headers || {})) {
      if (value === undefined || value === null) continue;
      headers[key] = String(value);
    }
    if (input.authorization) {
      headers.authorization = String(input.authorization);
      delete headers.Authorization;
    }
    if (input.cookie) {
      headers.cookie = String(input.cookie);
      delete headers.Cookie;
    }
    const record: ActorRecord = {
      id,
      label: String(input.label || existing?.label || id),
      roleHint: input.role_hint || input.roleHint || existing?.roleHint,
      headers: lowerAuthCookieKeys(headers),
      meta: { ...(existing?.meta || {}), ...(input.meta || {}) },
      updatedAt: new Date().toISOString(),
    };
    this.actors.set(id, record);
    if (!this.activeId) this.activeId = id;
    return record;
  }

  activate(id: string): ActorRecord {
    const record = this.actors.get(id);
    if (!record) throw new Error(`unknown actor: ${id}`);
    this.activeId = id;
    return record;
  }

  clearActive(): void {
    this.activeId = undefined;
  }

  /** Headers for a named actor, or the active actor when id is omitted. */
  headersFor(id?: string | null): Record<string, string> {
    if (id === null) return {};
    const record = id ? this.actors.get(id) : this.active();
    if (!record) return {};
    return { ...record.headers };
  }

  /**
   * Capture current session material into an actor (e.g. after login).
   * Merges into existing headers unless replaceHeaders is true.
   */
  capture(
    id: string,
    material: { headers?: Record<string, string>; authorization?: string; cookie?: string; meta?: Record<string, unknown>; label?: string; roleHint?: string },
    options: { replaceHeaders?: boolean; activate?: boolean } = {},
  ): ActorRecord {
    const record = this.upsert({
      id,
      label: material.label,
      roleHint: material.roleHint,
      headers: material.headers,
      authorization: material.authorization,
      cookie: material.cookie,
      meta: material.meta,
      replace_headers: options.replaceHeaders,
    });
    if (options.activate !== false) this.activeId = id;
    return record;
  }

  summary(): { active?: string; count: number; actors: Array<{ id: string; label: string; roleHint?: string; hasAuth: boolean; meta: Record<string, unknown> }> } {
    return {
      active: this.activeId,
      count: this.actors.size,
      actors: this.list().map((actor) => ({
        id: actor.id,
        label: actor.label,
        roleHint: actor.roleHint,
        hasAuth: Boolean(actor.headers.authorization || actor.headers.cookie),
        meta: actor.meta,
      })),
    };
  }
}

function lowerAuthCookieKeys(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers || {})) {
    const lower = key.toLowerCase();
    if (lower === "authorization") out.authorization = value;
    else if (lower === "cookie") out.cookie = value;
    else out[key] = value;
  }
  return out;
}
