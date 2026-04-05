'use strict';
// ── Pending Proposal Store ──────────────────────────────────────────────────
// Uses Supabase when configured, falls back to in-memory Map.
// In-memory store is fine for low volume — data is lost on server restart.

const memStore = new Map();

function useSupabase() {
  return !!(process.env.SUPABASE_URL && process.env.SUPABASE_KEY);
}

function supabaseHeaders() {
  return {
    'apikey': process.env.SUPABASE_KEY,
    'Authorization': `Bearer ${process.env.SUPABASE_KEY}`,
    'Content-Type': 'application/json',
  };
}

async function savePendingProposal(proposal) {
  if (useSupabase()) {
    const res = await fetch(`${process.env.SUPABASE_URL}/rest/v1/pending_proposals`, {
      method: 'POST',
      headers: { ...supabaseHeaders(), 'Prefer': 'return=minimal' },
      body: JSON.stringify(proposal),
    });
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Supabase save failed: ${res.status} ${err}`);
    }
  } else {
    memStore.set(proposal.id, { ...proposal });
  }
}

async function getPendingProposal(id) {
  if (useSupabase()) {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pending_proposals?id=eq.${encodeURIComponent(id)}&limit=1`,
      { headers: supabaseHeaders() }
    );
    if (!res.ok) return null;
    const rows = await res.json();
    return rows[0] || null;
  } else {
    return memStore.get(id) || null;
  }
}

async function updatePendingProposal(id, updates) {
  if (useSupabase()) {
    const res = await fetch(
      `${process.env.SUPABASE_URL}/rest/v1/pending_proposals?id=eq.${encodeURIComponent(id)}`,
      {
        method: 'PATCH',
        headers: { ...supabaseHeaders(), 'Prefer': 'return=minimal' },
        body: JSON.stringify(updates),
      }
    );
    if (!res.ok) {
      const err = await res.text();
      throw new Error(`Supabase update failed: ${res.status} ${err}`);
    }
  } else {
    const existing = memStore.get(id);
    if (existing) memStore.set(id, { ...existing, ...updates });
  }
}

module.exports = { savePendingProposal, getPendingProposal, updatePendingProposal };
