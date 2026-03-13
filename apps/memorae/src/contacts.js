/**
 * Contact Management module for Jarvis
 * Per-tenant address book stored in SQLite
 */
const db = require('./db');

// Ensure contacts table exists
function ensureContactsTable() {
  db.exec(`CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id INTEGER NOT NULL,
    name TEXT NOT NULL,
    phone TEXT,
    email TEXT,
    notes TEXT,
    category TEXT DEFAULT 'general',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (tenant_id) REFERENCES tenants(id)
  )`);
  
  // Create index for fast lookups
  try {
    db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_tenant ON contacts(tenant_id)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_contacts_name ON contacts(tenant_id, name)');
  } catch (e) { /* exists */ }
}

/**
 * Save a contact
 */
function saveContact(tenantId, { name, phone, email, notes, category }) {
  ensureContactsTable();
  
  // Check if contact exists (by name, case-insensitive)
  const existing = db.prepare(
    'SELECT id FROM contacts WHERE tenant_id = ? AND LOWER(name) = LOWER(?)'
  ).get(tenantId, name);
  
  if (existing) {
    // Update existing
    const updates = [];
    const params = [];
    if (phone !== undefined) { updates.push('phone = ?'); params.push(phone); }
    if (email !== undefined) { updates.push('email = ?'); params.push(email); }
    if (notes !== undefined) { updates.push('notes = ?'); params.push(notes); }
    if (category !== undefined) { updates.push('category = ?'); params.push(category); }
    updates.push("updated_at = CURRENT_TIMESTAMP");
    params.push(tenantId, name);
    
    db.prepare(`UPDATE contacts SET ${updates.join(', ')} WHERE tenant_id = ? AND LOWER(name) = LOWER(?)`).run(...params);
    return { success: true, message: `Updated contact "${name}"`, id: existing.id };
  } else {
    // Insert new
    const result = db.prepare(
      'INSERT INTO contacts (tenant_id, name, phone, email, notes, category) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(tenantId, name, phone || null, email || null, notes || null, category || 'general');
    return { success: true, message: `Saved contact "${name}"`, id: result.lastInsertRowid };
  }
}

/**
 * Search contacts by name (fuzzy)
 */
function searchContacts(tenantId, query) {
  ensureContactsTable();
  return db.prepare(
    "SELECT * FROM contacts WHERE tenant_id = ? AND (LOWER(name) LIKE LOWER(?) OR LOWER(notes) LIKE LOWER(?) OR phone LIKE ?)"
  ).all(tenantId, `%${query}%`, `%${query}%`, `%${query}%`);
}

/**
 * List all contacts
 */
function listContacts(tenantId, category = null) {
  ensureContactsTable();
  if (category) {
    return db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND category = ? ORDER BY name').all(tenantId, category);
  }
  return db.prepare('SELECT * FROM contacts WHERE tenant_id = ? ORDER BY name').all(tenantId);
}

/**
 * Get a specific contact by name
 */
function getContact(tenantId, name) {
  ensureContactsTable();
  return db.prepare('SELECT * FROM contacts WHERE tenant_id = ? AND LOWER(name) = LOWER(?)').get(tenantId, name);
}

/**
 * Delete a contact
 */
function deleteContact(tenantId, nameOrId) {
  ensureContactsTable();
  if (typeof nameOrId === 'number') {
    db.prepare('DELETE FROM contacts WHERE tenant_id = ? AND id = ?').run(tenantId, nameOrId);
  } else {
    db.prepare('DELETE FROM contacts WHERE tenant_id = ? AND LOWER(name) = LOWER(?)').run(tenantId, nameOrId);
  }
  return { success: true, message: `Deleted contact "${nameOrId}"` };
}

module.exports = { saveContact, searchContacts, listContacts, getContact, deleteContact, ensureContactsTable };
