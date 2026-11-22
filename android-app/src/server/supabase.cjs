let localCfg = {};
try { localCfg = require('./supabase-config.local.cjs'); } catch {}

const SUPABASE_URL = process.env.SUPABASE_URL || localCfg.url || '';
const SUPABASE_KEY = process.env.SUPABASE_KEY || localCfg.key || '';

class SupabaseSync {
  constructor(url = SUPABASE_URL, key = SUPABASE_KEY) {
    this.url = url.replace(/\/+$/, '');
    this.key = key;
    this.available = Boolean(this.url && this.key) && process.env.SUPABASE_DISABLED !== 'true';
  }

  headers(extra = {}) {
    return {
      apikey: this.key,
      Authorization: 'Bearer ' + this.key,
      'Content-Type': 'application/json',
      ...extra,
    };
  }

  async request(path, options = {}) {
    if (!this.available) return null;
    const endpoint = this.url + '/rest/v1/' + path;
    const res = await fetch(endpoint, {
      ...options,
      headers: this.headers(options.headers),
      signal: AbortSignal.timeout(7000),
    });
    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error('Supabase ' + res.status + ': ' + errText);
    }
    const text = await res.text();
    if (!text) return null;
    try { return JSON.parse(text); } catch { return text; }
  }

  // --- Users ---
  async getUsers() {
    return this.request('nms_users?select=username,salt,hash,role');
  }

  async upsertUser(user) {
    return this.request('nms_users', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify(user),
    });
  }

  async deleteUser(username) {
    return this.request('nms_users?username=eq.' + encodeURIComponent(username), {
      method: 'DELETE',
    });
  }

  // --- Settings (PIN, Router, etc) ---
  async getSettings() {
    return this.request('nms_settings?select=key,value');
  }

  async getSetting(key) {
    const records = await this.request('nms_settings?key=eq.' + encodeURIComponent(key) + '&select=value');
    return records?.[0]?.value ?? null;
  }

  async setSetting(key, value) {
    return this.request('nms_settings', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({ key, value, updated_at: new Date().toISOString() }),
    });
  }

  // --- OLTs ---
  async getOlts() {
    return this.request('nms_olts?select=*');
  }

  async upsertOlt(olt) {
    return this.request('nms_olts', {
      method: 'POST',
      headers: { Prefer: 'resolution=merge-duplicates' },
      body: JSON.stringify({
        host: olt.host,
        name: olt.name,
        community: olt.community,
        port: Number(olt.port || 161),
        admin_user: olt.adminUser || null,
        admin_password: olt.adminPassword || null,
        oids: olt.oids || null,
        rx_divider: olt.rxDivider || 1,
        updated_at: new Date().toISOString(),
      }),
    });
  }

  async deleteOlt(host) {
    return this.request('nms_olts?host=eq.' + encodeURIComponent(host), {
      method: 'DELETE',
    });
  }

  async replaceAllOlts(olts) {
    if (!Array.isArray(olts) || !olts.length) return;
    // Delete existing and insert new
    await this.request('nms_olts?host=neq.0.0.0.0', { method: 'DELETE' });
    const records = olts.map(olt => ({
      host: olt.host,
      name: olt.name,
      community: olt.community,
      port: Number(olt.port || 161),
      admin_user: olt.adminUser || null,
      admin_password: olt.adminPassword || null,
      oids: olt.oids || null,
      rx_divider: olt.rxDivider || 1,
      updated_at: new Date().toISOString(),
    }));
    return this.request('nms_olts', {
      method: 'POST',
      body: JSON.stringify(records),
    });
  }

  // --- Audit Trail ---
  async getAuditLog(limit = 250) {
    return this.request('nms_audit?order=at.desc&limit=' + limit);
  }

  async insertAudit(entry) {
    const res = await this.request('nms_audit', {
      method: 'POST',
      headers: { Prefer: 'return=representation' },
      body: JSON.stringify(entry),
    });
    return Array.isArray(res) ? res[0] : res;
  }

  async updateAudit(id, patch) {
    return this.request('nms_audit?id=eq.' + id, {
      method: 'PATCH',
      body: JSON.stringify(patch),
    });
  }
}

module.exports = {
  SupabaseSync,
  supabase: new SupabaseSync(),
};
