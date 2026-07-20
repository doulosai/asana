// lib/utils.js — Shared utilities for all Dwellia scheduler endpoints

// ── Constants ─────────────────────────────────────────────────────────────────

export const ASANA_BASE      = 'https://app.asana.com/api/1.0';
export const HOSPITABLE_BASE = 'https://public.api.hospitable.com';

// Asana project GIDs
export const PROJECTS = {
  schedule_config: '1214473265107647',  // 🗓️ Maintenance Schedule Config (source of truth)
  delta_dawn:      '1200748932634513',  // Delta Dawn Maintenance
  legobi_villa:    '1204026608001469',  // LeGobi Villa Maintenance
};

// Hospitable property IDs — fill these in after checking your Hospitable account
export const HOSPITABLE_PROPERTIES = {
  delta_dawn:   process.env.HOSPITABLE_PROPERTY_DELTA_DAWN,
  legobi_villa: process.env.HOSPITABLE_PROPERTY_LEGOBI,
};

// Assignees
export const ASSIGNEES = {
  delta_dawn:   { gid: '1202811494442466', name: 'Ryan',   phone: process.env.RYAN_PHONE },
  legobi_villa: { gid: '1204089449363429', name: 'Amanda', phone: process.env.AMANDA_PHONE },
};

export const JORDAN_EMAIL = 'admin@bookdwellia.com';
export const JORDAN_GID   = '1200027663054269';

// Section GIDs in the maintenance projects (where scheduled tasks are created)
export const MAINTENANCE_SECTIONS = {
  delta_dawn: {
    '1_month':  '1202096817619652',
    '3_months': '1200748932634519',
    '6_months': '1202800056668861',
    '12_months':'1200748932634522',
    '24_months':'1202800056668864',
    'ad_hoc':   '1202800056668818',
  },
  legobi_villa: {
    '1_month':  '1204093776127180',
    '2_months': '1204093776127181',
    '3_months': '1204093776127184',
    '6_months': '1204093776127187',
    '12_months':'1204093776127190',
    'ad_hoc':   '1204093776126081',
  },
};

// Frequency → section key mapping
export const frequencyToSection = (days) => {
  if (days <= 30)  return '1_month';
  if (days <= 60)  return '2_months';
  if (days <= 90)  return '3_months';
  if (days <= 180) return '6_months';
  if (days <= 365) return '12_months';
  return '24_months';
};

// ── Asana API ─────────────────────────────────────────────────────────────────

export async function asana(method, path, body) {
  const token = process.env.ASANA_TOKEN;
  if (!token) throw new Error('ASANA_TOKEN not set');

  const res = await fetch(`${ASANA_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: body ? JSON.stringify({ data: body }) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Asana ${method} ${path} → ${res.status}: ${err}`);
  }
  return res.json();
}

/**
 * Fetch all tasks from a project, paginating automatically.
 * Returns full task objects with the fields you specify.
 */
export async function getAllTasks(id, optFields = 'name,notes,due_on,completed,assignee,memberships', bySection = false) {
  const tasks = [];
  let offset = null;
  const param = bySection ? 'section' : 'project';

  do {
    const qs = new URLSearchParams({ [param]: id, opt_fields: optFields, limit: '100' });
    if (offset) qs.set('offset', offset);
    const res = await asana('GET', `/tasks?${qs}`);
    tasks.push(...res.data);
    offset = res.next_page?.offset ?? null;
  } while (offset);

  return tasks;
}

/**
 * Get all INCOMPLETE tasks for a project (for duplicate checking).
 * Returns a Map of lowercase task name → task GID.
 */
export async function getOpenTaskMap(projectId) {
  const map = new Map();
  let offset = null;

  do {
    const qs = new URLSearchParams({
      project:          projectId,
      completed_since:  'now',
      opt_fields:       'name,gid',
      limit:            '100',
    });
    if (offset) qs.set('offset', offset);
    const res = await asana('GET', `/tasks?${qs}`);
    for (const t of res.data) map.set(t.name.toLowerCase().trim(), t.gid);
    offset = res.next_page?.offset ?? null;
  } while (offset);

  return map;
}

// ── Hospitable API ────────────────────────────────────────────────────────────

export async function hospitable(path, method = 'GET', body = null) {
  const token = process.env.HOSPITABLE_TOKEN;
  if (!token) throw new Error('HOSPITABLE_TOKEN not set');

  const res = await fetch(`${HOSPITABLE_BASE}${path}`, {
    method,
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
      'Accept':        'application/json',
    },
    body: body ? JSON.stringify(body) : undefined,
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Hospitable ${method} ${path} → ${res.status}: ${err}`);
  }
  return res.json();
}

/**
 * Get checkout dates for a property over a date range.
 * Uses the reservations endpoint to find all checkouts in the window.
 * Returns sorted array of unique date strings (YYYY-MM-DD).
 */
export async function getCheckoutDates(propertyId, fromDate, toDate) {
  // v2 reservations endpoint — filter by property UUID and date range
  const data = await hospitable(
    `/v2/reservations?properties[]=${propertyId}&date_query=checkout&start_date=${fromDate}&end_date=${toDate}&per_page=100`
  );

  const reservations = data.data || [];

  // departure_date is the checkout date in Hospitable v2
  const checkouts = reservations
    .map(r => r.departure_date || r.check_out || r.end_date)
    .filter(Boolean)
    .map(d => d.split('T')[0])
    .filter(d => d >= fromDate && d <= toDate)
    .sort();

  return [...new Set(checkouts)];
}

/**
 * Find the next checkout date on or after a given date, within a window.
 * Returns null if no checkout found within the window.
 */
export function findNextCheckout(checkoutDates, fromDate, windowDays = 30) {
  const from  = new Date(fromDate);
  const until = new Date(fromDate);
  until.setDate(until.getDate() + windowDays);

  return checkoutDates.find(d => {
    const date = new Date(d);
    return date >= from && date <= until;
  }) || null;
}

// ── Date helpers ──────────────────────────────────────────────────────────────

export const today = () => new Date().toISOString().split('T')[0];

export function addDays(dateStr, days) {
  const d = new Date(dateStr);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

export function daysBetween(a, b) {
  return Math.round((new Date(b) - new Date(a)) / 86400000);
}

export function formatDate(dateStr) {
  return new Date(dateStr).toLocaleDateString('en-US', {
    weekday: 'short', month: 'short', day: 'numeric',
  });
}

// ── Gmail (via nodemailer + Gmail OAuth / App Password) ───────────────────────

export async function sendEmail({ to, subject, html, text }) {
  const { createTransport } = await import('nodemailer');

  const transporter = createTransport({
    service: 'gmail',
    auth: {
      user: process.env.GMAIL_USER,   // jordan@liftbridgecap.com
      pass: process.env.GMAIL_APP_PASSWORD, // Gmail App Password (not your login password)
    },
  });

  return transporter.sendMail({
    from:    `"Dwellia Ops" <${process.env.GMAIL_USER}>`,
    to,
    subject,
    html,
    text,
  });
}

// ── Quo SMS (OpenPhone API) ───────────────────────────────────────────────────
// Quo is a rebrand of OpenPhone. API base remains api.openphone.com.
// Auth: Authorization header with raw API key (no "Bearer" prefix).
// "from" field = phone number ID in format PN... (not a raw phone number).
// SMS is fully disabled until SMS_ENABLED=true is set in Vercel env vars.

export async function sendSMS({ to, message }) {
  // 🔒 Safety gate — SMS disabled until you explicitly enable it in Vercel
  if (process.env.SMS_ENABLED !== 'true') {
    console.log(`[SMS DISABLED] Would have sent to ${to}: ${message}`);
    return { disabled: true, to, message };
  }

  const token         = process.env.QUO_API_TOKEN;
  const phoneNumberId = process.env.QUO_PHONE_NUMBER_ID; // format: PN...

  if (!token)         throw new Error('QUO_API_TOKEN not set');
  if (!phoneNumberId) throw new Error('QUO_PHONE_NUMBER_ID not set');

  const res = await fetch('https://api.openphone.com/v1/messages', {
    method: 'POST',
    headers: {
      'Authorization': token,        // no "Bearer" prefix per Quo/OpenPhone docs
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({
      content: message,
      from:    phoneNumberId,        // e.g. "PNxxxxxxxx"
      to:      [to],                 // array of E.164 phone numbers
      setInboxStatus: 'done',        // keep inbox tidy — moves to Done after send
    }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Quo SMS → ${res.status}: ${err}`);
  }
  return res.json();
}

// ── Schedule config parser ────────────────────────────────────────────────────

/**
 * Parse the notes field of a schedule config task to extract metadata.
 * Notes contain lines like:
 *   FREQUENCY: 90 days
 *   PROPERTY: delta_dawn
 */
export function parseTaskNotes(notes = '') {
  const lines = notes.split('\n');
  const meta  = {};

  for (const line of lines) {
    const [key, ...rest] = line.split(':');
    if (!key || !rest.length) continue;
    const k = key.trim().toUpperCase().replace(/\s+/g, '_');
    const v = rest.join(':').trim();
    meta[k] = v;
  }

  return {
    frequencyDays: parseInt(meta['FREQUENCY']) || null,
    property:      meta['PROPERTY'] || null,
  };
}
