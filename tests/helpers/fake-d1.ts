// tests/helpers/fake-d1.ts
// ─────────────────────────────────────────────────────────────────────────────
// D1 simulada en memoria con SOLO las sentencias que usa el módulo de defensa.
// Si el código empieza a usar una consulta nueva y no está aquí, la prueba falla
// con «SQL no soportado»: así no se queda sin cubrir sin que nadie se entere.
// ─────────────────────────────────────────────────────────────────────────────

type Row = Record<string, any>;
type Result = { results?: Row[]; row?: Row | null; changes?: number };

export class FakeD1 {
  settings = new Map<string, string>();
  blocks: Row[] = [];
  allows: Row[] = [];
  honeypot: Row[] = [];
  rules: Row[] = [];
  events: Row[] = [];
  hourly: Row[] = [];
  /** Historial de SQL ejecutado (normalizado), por si una prueba quiere comprobarlo. */
  log: string[] = [];
  /** Si se define y devuelve un Error, esa sentencia falla (para simular caídas de D1). */
  failWhen: ((sql: string) => Error | null) | null = null;

  private ids = { blocks: 1, allows: 1, rules: 1 };

  constructor(initialSettings: Record<string, string> = {}) {
    for (const [k, v] of Object.entries(initialSettings)) this.settings.set(k, v);
  }

  // ── Utilidades para preparar escenarios ─────────────────────────────────
  setSettings(obj: Record<string, string>) { for (const [k, v] of Object.entries(obj)) this.settings.set(k, v); return this; }
  addBlockRow(r: { kind?: string; value: string; source?: string; reason?: string | null; expires_at?: string | null }) {
    this.blocks.push({ id: this.ids.blocks++, kind: 'ip', source: 'manual', reason: null, expires_at: null, created_at: new Date().toISOString(), ...r });
    return this;
  }
  addAllowRow(r: { kind?: string; value: string; note?: string }) {
    this.allows.push({ id: this.ids.allows++, kind: 'ip', note: null, created_at: new Date().toISOString(), ...r });
    return this;
  }
  addHoneypotIp(ip: string) { this.honeypot.push({ ip, detected_at: new Date().toISOString() }); return this; }
  addRuleRow(r: { name: string; scope: string; path_pattern?: string; max_hits: number; window_s: number; action?: string; ban_minutes?: number; enabled?: number }) {
    this.rules.push({ id: this.ids.rules++, enabled: 1, path_pattern: '/blog/*', action: 'flag', ban_minutes: 15, ...r });
    return this;
  }
  /** Eventos de un tipo (p. ej. 'auto_ban'). */
  eventsOf(type: string) { return this.events.filter((e) => e.type === type); }
  blockWhere(value: string) { return this.blocks.find((b) => b.value === value); }

  // ── Interfaz D1 ─────────────────────────────────────────────────────────
  prepare(sql: string) {
    const flat = sql.replace(/\s+/g, ' ').trim();
    return new Stmt(this, flat, []);
  }
  async batch(stmts: Stmt[]) {
    for (const s of stmts) await s.run();
    return [];
  }

  /** @internal */
  exec(flat: string, args: any[]): Result {
    this.log.push(flat);
    const err = this.failWhen?.(flat);
    if (err) throw err;
    const nowIso = new Date().toISOString();
    const active = (b: Row) => b.expires_at === null || b.expires_at === undefined || b.expires_at > (args[0] ?? nowIso);

    // ── Lecturas ────────────────────────────────────────────────────────
    if (flat.startsWith('SELECT key, value FROM settings WHERE key IN')) {
      return { results: [...this.settings].map(([key, value]) => ({ key, value })) };
    }
    if (flat.startsWith('SELECT value FROM settings WHERE key = ?')) {
      const v = this.settings.get(args[0]);
      return { row: v === undefined ? null : { value: v } };
    }
    if (flat.startsWith('SELECT id, kind, value, source, reason FROM blocked_ips')) {
      return { results: this.blocks.filter(active) };
    }
    if (flat.startsWith('SELECT id, kind, value FROM allow_list')) return { results: this.allows };
    if (flat.startsWith('SELECT ip FROM bot_ips')) return { results: this.honeypot };
    if (flat.startsWith('SELECT id, name, scope, path_pattern, max_hits, window_s, action, ban_minutes FROM defense_rules WHERE enabled = 1')) {
      return { results: this.rules.filter((r) => r.enabled === 1) };
    }
    if (flat === 'SELECT COUNT(*) AS n FROM defense_rules') return { row: { n: this.rules.length } };
    if (flat.startsWith("SELECT COUNT(*) AS n FROM blocked_ips WHERE source = 'auto'")) {
      return { row: { n: this.blocks.filter((b) => b.source === 'auto' && active(b)).length } };
    }
    if (flat.startsWith('SELECT COUNT(*) AS n FROM blocked_ips WHERE expires_at IS NULL OR expires_at > ?')) {
      return { row: { n: this.blocks.filter(active).length } };
    }
    if (flat.startsWith('SELECT COALESCE(SUM(flagged),0) AS f')) {
      const sum = (k: string) => this.hourly.reduce((a, h) => a + (h[k] ?? 0), 0);
      return { row: { f: sum('flagged'), b: sum('blocked') + sum('limited'), m: sum('maint') } };
    }

    // ── Escrituras: ajustes ─────────────────────────────────────────────
    if (flat.startsWith('INSERT INTO settings') && flat.includes('WHERE CAST(value AS INTEGER) < ?')) {
      const [key, value, threshold] = args;
      const cur = this.settings.get(key);
      if (cur === undefined || Number(cur) < Number(threshold)) { this.settings.set(key, String(value)); return { changes: 1 }; }
      return { changes: 0 };
    }
    if (flat.startsWith('INSERT INTO settings')) { this.settings.set(args[0], String(args[1])); return { changes: 1 }; }
    if (flat.startsWith('DELETE FROM settings WHERE key = ?')) { return { changes: this.settings.delete(args[0]) ? 1 : 0 }; }

    // ── Escrituras: listas ──────────────────────────────────────────────
    if (flat.startsWith('INSERT INTO blocked_ips')) {
      const [kind, value, reason, source, created_at, expires_at] = args;
      const cur = this.blocks.find((b) => b.kind === kind && b.value === value);
      if (cur) Object.assign(cur, { reason, source, expires_at });
      else this.blocks.push({ id: this.ids.blocks++, kind, value, reason, source, created_at, expires_at });
      return { changes: 1 };
    }
    if (flat.startsWith('DELETE FROM blocked_ips WHERE id = ?')) { this.blocks = this.blocks.filter((b) => b.id !== args[0]); return { changes: 1 }; }
    if (flat.startsWith('INSERT INTO allow_list')) {
      const [kind, value, note, created_at] = args;
      const cur = this.allows.find((a) => a.kind === kind && a.value === value);
      if (cur) cur.note = note; else this.allows.push({ id: this.ids.allows++, kind, value, note, created_at });
      return { changes: 1 };
    }
    if (flat.startsWith('DELETE FROM allow_list WHERE id = ?')) { this.allows = this.allows.filter((a) => a.id !== args[0]); return { changes: 1 }; }

    // ── Escrituras: reglas ──────────────────────────────────────────────
    if (flat.startsWith('INSERT INTO defense_rules')) {
      const [name, scope, path_pattern, max_hits, window_s, action, ban_minutes] = args;
      this.rules.push({ id: this.ids.rules++, name, enabled: 1, scope, path_pattern, max_hits, window_s, action, ban_minutes });
      return { changes: 1 };
    }
    if (flat.startsWith('UPDATE defense_rules SET name=?')) {
      const [name, scope, path_pattern, max_hits, window_s, action, ban_minutes, id] = args;
      const r = this.rules.find((x) => x.id === id);
      if (r) Object.assign(r, { name, scope, path_pattern, max_hits, window_s, action, ban_minutes });
      return { changes: r ? 1 : 0 };
    }
    if (flat.startsWith('UPDATE defense_rules SET enabled = ?')) {
      const r = this.rules.find((x) => x.id === args[1]); if (r) r.enabled = args[0]; return { changes: r ? 1 : 0 };
    }
    if (flat === 'DELETE FROM defense_rules') { const n = this.rules.length; this.rules = []; return { changes: n }; }
    if (flat.startsWith('DELETE FROM defense_rules WHERE id = ?')) { this.rules = this.rules.filter((r) => r.id !== args[0]); return { changes: 1 }; }

    // ── Escrituras: eventos y contadores ────────────────────────────────
    if (flat.startsWith('INSERT INTO defense_events')) {
      const [ts, type, ip, detail] = args; this.events.push({ ts, type, ip, detail }); return { changes: 1 };
    }
    if (flat.startsWith('INSERT INTO defense_hourly')) {
      const [hour, flagged, limited, blocked, maint] = args;
      const cur = this.hourly.find((h) => h.hour === hour);
      if (cur) { cur.flagged += flagged; cur.limited += limited; cur.blocked += blocked; cur.maint += maint; }
      else this.hourly.push({ hour, flagged, limited, blocked, maint });
      return { changes: 1 };
    }

    throw new Error(`FakeD1: SQL no soportado: ${flat.slice(0, 140)}`);
  }
}

export class Stmt {
  constructor(private db: FakeD1, public sql: string, public args: any[]) {}
  bind(...args: any[]) { return new Stmt(this.db, this.sql, args); }
  async all() { const r = this.db.exec(this.sql, this.args); return { results: r.results ?? [] }; }
  async first() { const r = this.db.exec(this.sql, this.args); return r.row ?? null; }
  async run() { const r = this.db.exec(this.sql, this.args); return { meta: { changes: r.changes ?? 0 } }; }
}
