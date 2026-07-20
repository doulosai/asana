// api/reminders.js
// Runs daily at 1pm UTC via Vercel cron.
// Checks maintenance tasks due tomorrow (day-before reminder)
// and tasks due yesterday that are still incomplete (day-after alert).
// Sends SMS via Quo to Ryan/Amanda, email to Jordan if overdue.

import {
  getAllTasks,
  ASSIGNEES, JORDAN_EMAIL,
  sendEmail, sendSMS,
  today, addDays, formatDate,
} from '../lib/utils.js';

// All frequency sections across both properties
const FREQUENCY_SECTIONS = {
  // Delta Dawn
  '1202096817619652': 'delta_dawn',
  '1200748932634519': 'delta_dawn',
  '1202800056668861': 'delta_dawn',
  '1200748932634522': 'delta_dawn',
  '1202800056668864': 'delta_dawn',
  // LeGobi
  '1204093776127180': 'legobi_villa',
  '1204093776127181': 'legobi_villa',
  '1204093776127187': 'legobi_villa',
  '1204093776127190': 'legobi_villa',
  '1216644012125058': 'legobi_villa',
};

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const todayStr     = today();
  const tomorrowStr  = addDays(todayStr, 1);
  const yesterdayStr = addDays(todayStr, -1);

  console.log(`[reminders] Running for ${todayStr}`);
  const sent = { sms: [], emails: [] };

  // Load all incomplete tasks from frequency sections, grouped by property
  const tasksByProperty = { delta_dawn: [], legobi_villa: [] };

  for (const [sectionGid, propKey] of Object.entries(FREQUENCY_SECTIONS)) {
    const tasks = await getAllTasks(sectionGid, 'gid,name,due_on,completed', true);
    const incomplete = tasks.filter(t => !t.completed && t.due_on);
    tasksByProperty[propKey].push(...incomplete);
  }

  // Process each property
  for (const [propKey, tasks] of Object.entries(tasksByProperty)) {
    const assignee  = ASSIGNEES[propKey];
    const propLabel = propKey === 'delta_dawn' ? 'Delta Dawn' : 'LeGobi Villa';

    // ── Day-before reminders ───────────────────────────────────────────────
    const dueTomorrow = tasks.filter(t => t.due_on === tomorrowStr);
    for (const task of dueTomorrow) {
      const message = `Hey ${assignee.name}! Heads up — "${task.name}" at ${propLabel} is due tomorrow (${formatDate(tomorrowStr)}). Just a reminder to get it done during the turnover. Thanks!`;
      try {
        if (assignee.phone) {
          await sendSMS({ to: assignee.phone, message });
          console.log(`[reminders] 📱 SMS to ${assignee.name} — "${task.name}" (day before)`);
          sent.sms.push({ to: assignee.name, task: task.name, type: 'day_before' });
        }
      } catch (err) {
        console.error(`[reminders] SMS failed for "${task.name}":`, err.message);
      }
    }

    // ── Day-after alerts (still incomplete) ───────────────────────────────
    const overdueYesterday = tasks.filter(t => t.due_on === yesterdayStr);
    for (const task of overdueYesterday) {
      const assigneeMsg = `Hey ${assignee.name} — "${task.name}" at ${propLabel} was due yesterday and isn't marked complete yet. Can you let Jordan know if it's done or if there's an issue? Thanks`;
      const jordanMsg   = `⚠️ Maintenance overdue at ${propLabel}: "${task.name}" was due ${formatDate(yesterdayStr)} and isn't marked complete in Asana. ${assignee.name} has been texted.`;

      try {
        if (assignee.phone) {
          await sendSMS({ to: assignee.phone, message: assigneeMsg });
          console.log(`[reminders] 📱 SMS to ${assignee.name} — overdue "${task.name}"`);
          sent.sms.push({ to: assignee.name, task: task.name, type: 'day_after_assignee' });
        }
      } catch (err) {
        console.error(`[reminders] Assignee SMS failed:`, err.message);
      }

      try {
        await sendEmail({
          to:      JORDAN_EMAIL,
          subject: `⚠️ Overdue maintenance: ${task.name} — ${propLabel}`,
          text:    jordanMsg,
          html: `
            <div style="font-family: sans-serif; max-width: 600px;">
              <h2 style="color: #c0392b;">⚠️ Overdue Maintenance Task</h2>
              <table style="border-collapse: collapse; width: 100%;">
                <tr><td style="padding: 8px; font-weight: bold; width: 140px;">Property</td><td style="padding: 8px;">${propLabel}</td></tr>
                <tr style="background:#f9f9f9"><td style="padding: 8px; font-weight: bold;">Task</td><td style="padding: 8px;">${task.name}</td></tr>
                <tr><td style="padding: 8px; font-weight: bold;">Was due</td><td style="padding: 8px;">${formatDate(yesterdayStr)}</td></tr>
                <tr style="background:#f9f9f9"><td style="padding: 8px; font-weight: bold;">Assigned to</td><td style="padding: 8px;">${assignee.name}</td></tr>
              </table>
              <p style="margin-top: 16px; color: #555;">${assignee.name} has been texted. If this was completed, ask them to mark it done in Asana.</p>
              <p style="color: #aaa; font-size: 12px;">Dwellia Maintenance Scheduler</p>
            </div>
          `,
        });
        console.log(`[reminders] 📧 Email to Jordan — overdue "${task.name}"`);
        sent.emails.push({ task: task.name, property: propKey, type: 'overdue_alert' });
      } catch (err) {
        console.error(`[reminders] Jordan email failed:`, err.message);
      }
    }
  }

  return res.status(200).json({ success: true, date: todayStr, sent });
}
