// api/scheduler.js
// Runs daily at 12pm UTC via Vercel cron.
// Reads the Maintenance Schedule Config project in Asana,
// pulls checkout dates from Hospitable, and creates tasks
// in the maintenance projects timed to checkout/cleaning days.

import {
  asana, getAllTasks, getOpenTaskMap,
  getCheckoutDates, findNextCheckout,
  PROJECTS, ASSIGNEES, MAINTENANCE_SECTIONS,
  HOSPITABLE_PROPERTIES, frequencyToSection,
  parseTaskNotes, today, addDays, daysBetween,
} from '../lib/utils.js';

export default async function handler(req, res) {
  // Allow manual triggering via GET, Vercel cron sends GET too
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  // Optional: secure the endpoint with a secret
  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  console.log(`[scheduler] Starting run — ${today()}`);
  const results = { created: [], skipped: [], errors: [] };

  try {
    // ── Step 1: Load recurring tasks from frequency sections of each project ──
    console.log('[scheduler] Loading recurring tasks from Asana frequency sections...');

    // Section GIDs → frequency in days
    const FREQUENCY_SECTIONS = {
      // Delta Dawn
      '1202096817619652': { days: 30,  property: 'delta_dawn',   label: '1 Month'  },
      '1200748932634519': { days: 90,  property: 'delta_dawn',   label: '3 Months' },
      '1202800056668861': { days: 180, property: 'delta_dawn',   label: '6 Months' },
      '1200748932634522': { days: 365, property: 'delta_dawn',   label: '12 Months'},
      '1202800056668864': { days: 730, property: 'delta_dawn',   label: '24 Months'},
      // LeGobi
      '1204093776127180': { days: 30,  property: 'legobi_villa', label: '1 Month'  },
      '1204093776127181': { days: 60,  property: 'legobi_villa', label: '2 Months' },
      '1204093776127184': { days: 90,  property: 'legobi_villa', label: '3 Months' },
      '1204093776127187': { days: 180, property: 'legobi_villa', label: '6 Months' },
      '1204093776127190': { days: 365, property: 'legobi_villa', label: '12 Months'},
    };

    // Load all incomplete tasks from every frequency section
    const activeTasks = [];
    for (const [sectionGid, meta] of Object.entries(FREQUENCY_SECTIONS)) {
      const tasks = await getAllTasks(sectionGid, 'gid,name,notes,due_on,completed,memberships.section.gid');
      const incomplete = tasks.filter(t => !t.completed && t.due_on);
      for (const t of incomplete) {
        activeTasks.push({ ...t, _frequencyDays: meta.days, _property: meta.property, _sectionGid: sectionGid });
      }
    }
    console.log(`[scheduler] Found ${activeTasks.length} active recurring tasks`);

    // ── Step 2: Load checkout dates for both properties (next 90 days) ────
    const fromDate = today();
    const toDate   = addDays(fromDate, 90);

    const checkouts = {};
    for (const [propKey, propId] of Object.entries(HOSPITABLE_PROPERTIES)) {
      if (!propId) {
        console.warn(`[scheduler] No Hospitable property ID for ${propKey} — skipping calendar`);
        checkouts[propKey] = [];
        continue;
      }
      console.log(`[scheduler] Fetching checkout dates for ${propKey}...`);
      checkouts[propKey] = await getCheckoutDates(propId, fromDate, toDate);
      console.log(`[scheduler] ${propKey}: ${checkouts[propKey].length} checkouts found in next 90 days`);
    }

    // ── Step 3: Load open tasks per maintenance project (duplicate check) ─
    const openTaskMaps = {};
    for (const [propKey, projectId] of Object.entries({
      delta_dawn:   PROJECTS.delta_dawn,
      legobi_villa: PROJECTS.legobi_villa,
    })) {
      openTaskMaps[propKey] = await getOpenTaskMap(projectId);
    }

    // ── Step 4: Process each schedule item ────────────────────────────────
    for (const task of activeTasks) {
      try {
        const frequencyDays = task._frequencyDays;
        const property      = task._property;

        // last_completed = the due_on date on the current incomplete task
        // (set by you manually, or by the scheduler from the previous completed task)
        const lastCompleted = task.due_on;

        // When is this task next due?
        const nextDueWindow = addDays(lastCompleted, frequencyDays);

        // Already have an open task with this name? Skip.
        const openMap = openTaskMaps[property];
        if (openMap.has(task.name.toLowerCase().trim())) {
          results.skipped.push({ task: task.name, property, reason: 'already open' });
          continue;
        }

        // Find the next checkout on or after the due window
        const propCheckouts = checkouts[property] || [];
        const scheduledDate = findNextCheckout(propCheckouts, nextDueWindow, 45)
          || nextDueWindow; // fallback: schedule on due date if no checkout found

        // Only create if it's within the next 60 days (don't schedule too far ahead)
        const daysOut = daysBetween(today(), scheduledDate);
        if (daysOut > 60) {
          results.skipped.push({ task: task.name, property, reason: `not due yet (${daysOut}d out)`, scheduledDate });
          continue;
        }

        // New task goes back into the same section the template lives in
        const sectionId  = task._sectionGid;
        const projectId  = PROJECTS[property];
        const assignee   = ASSIGNEES[property];

        // Create the task
        const created = await asana('POST', '/tasks', {
          name:        task.name,
          notes:       task.notes || '',
          due_on:      scheduledDate,
          assignee:    assignee.gid,
          projects:    [projectId],
          memberships: [{ project: projectId, section: sectionId }],
        });

        // Add to open map so we don't double-create in same run
        openMap.set(task.name.toLowerCase().trim(), created.data.gid);

        const checkoutNote = scheduledDate !== nextDueWindow
          ? `(matched to checkout day, due window was ${nextDueWindow})`
          : `(no checkout found, using due date)`;

        console.log(`[scheduler] ✅ Created "${task.name}" for ${property} on ${scheduledDate} ${checkoutNote}`);
        results.created.push({ task: task.name, property, scheduledDate, gid: created.data.gid });

      } catch (taskErr) {
        console.error(`[scheduler] ❌ Error processing "${task.name}":`, taskErr.message);
        results.errors.push({ task: task.name, error: taskErr.message });
      }
    }

    console.log(`[scheduler] Done. Created: ${results.created.length}, Skipped: ${results.skipped.length}, Errors: ${results.errors.length}`);

    return res.status(200).json({
      success:   true,
      date:      today(),
      summary:   { created: results.created.length, skipped: results.skipped.length, errors: results.errors.length },
      details:   results,
    });

  } catch (err) {
    console.error('[scheduler] Fatal error:', err);
    return res.status(500).json({ success: false, error: err.message });
  }
}
