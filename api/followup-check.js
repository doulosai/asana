// api/followup-check.js
// Runs daily — checks sms_followups table for tasks promised by today.
// If still incomplete, texts the assignee once to check in.

import { neon } from '@neondatabase/serverless';
import {
  asana, sendSMS, today,
} from '../lib/utils.js';

export default async function handler(req, res) {
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).end();
  }

  const secret = req.headers['x-cron-secret'] || req.query.secret;
  if (process.env.CRON_SECRET && secret !== process.env.CRON_SECRET) {
    return res.status(401).json({ error: 'Unauthorized' });
  }

  const sql = neon(process.env.DATABASE_URL);
  const todayStr = today();

  // Get all followups due today or earlier
  const followups = await sql`
    SELECT * FROM sms_followups
    WHERE followup_date <= ${todayStr}
  `;

  console.log(`[followup-check] ${followups.length} followup(s) due`);

  for (const followup of followups) {
    // Check if the task is already complete in Asana
    const task = await asana('GET', `/tasks/${followup.task_gid}?opt_fields=completed,name`);

    if (task.data.completed) {
      // Already done — clean up and move on
      await sql`DELETE FROM sms_followups WHERE id = ${followup.id}`;
      console.log(`[followup-check] "${followup.task_name}" already complete — removed followup`);
      continue;
    }

    // Still not done — send one check-in text
    await sendSMS({
      to: followup.phone,
      message: `Hey — were you able to get "${followup.task_name}" done today?`,
    });

    // Remove from followups — if they reply "yes" the sms-reply handler takes over
    await sql`DELETE FROM sms_followups WHERE id = ${followup.id}`;
    console.log(`[followup-check] Sent followup for "${followup.task_name}" to ${followup.phone}`);
  }

  return res.status(200).json({ ok: true, checked: followups.length });
}
