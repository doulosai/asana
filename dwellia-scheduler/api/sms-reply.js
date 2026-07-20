// api/sms-reply.js
// Quo webhook endpoint — fires on message.received when Amanda or Ryan replies.
// Claude reads the message, identifies the task, and updates Asana accordingly.
// Register this URL in Quo: Settings → Webhooks → message.received
// URL: https://asana-eight.vercel.app/api/sms-reply

import { neon } from '@neondatabase/serverless';
import Anthropic from '@anthropic-ai/sdk';
import {
  getAllTasks, asana,
  ASSIGNEES, PROJECTS,
  sendSMS, today, addDays,
} from '../lib/utils.js';

const FREQUENCY_SECTIONS = {
  '1202096817619652': { days: 30,  property: 'delta_dawn'   },
  '1200748932634519': { days: 90,  property: 'delta_dawn'   },
  '1202800056668861': { days: 180, property: 'delta_dawn'   },
  '1200748932634522': { days: 365, property: 'delta_dawn'   },
  '1202800056668864': { days: 730, property: 'delta_dawn'   },
  '1204093776127180': { days: 30,  property: 'legobi_villa' },
  '1204093776127181': { days: 60,  property: 'legobi_villa' },
  '1204093776127187': { days: 180, property: 'legobi_villa' },
  '1204093776127190': { days: 365, property: 'legobi_villa' },
  '1216644012125058': { days: 730, property: 'legobi_villa' },
};

async function initDb() {
  const sql = neon(process.env.DATABASE_URL);
  await sql`
    CREATE TABLE IF NOT EXISTS sms_followups (
      id SERIAL PRIMARY KEY,
      phone TEXT NOT NULL,
      task_gid TEXT NOT NULL,
      task_name TEXT NOT NULL,
      property TEXT NOT NULL,
      followup_date TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    )
  `;
  return sql;
}

async function getOpenTasksForPhone(phone) {
  // Figure out which property this phone belongs to
  const property = Object.entries(ASSIGNEES).find(
    ([, a]) => a.phone === phone
  )?.[0];

  if (!property) return { property: null, tasks: [] };

  const tasks = [];
  for (const [sectionGid, meta] of Object.entries(FREQUENCY_SECTIONS)) {
    if (meta.property !== property) continue;
    const sectionTasks = await getAllTasks(sectionGid, 'gid,name,due_on,completed', true);
    tasks.push(...sectionTasks.filter(t => !t.completed));
  }

  return { property, tasks };
}

async function markTaskComplete(taskGid, completedDate) {
  // Asana doesn't allow setting completed_at directly — mark complete and update due_on
  await asana('PUT', `/tasks/${taskGid}`, { completed: true });
  // Set due_on to the actual completion date so scheduler uses it for next cycle
  await asana('PUT', `/tasks/${taskGid}`, { due_on: completedDate });
}

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).end();

  const payload = req.body;

  // Quo webhook payload — message.received event
  const event = payload?.event || payload?.type;
  if (event !== 'message.received' && event !== 'message_received') {
    return res.status(200).json({ ignored: true });
  }

  const messageBody = payload?.data?.object?.body
    || payload?.data?.body
    || payload?.body
    || '';

  const fromPhone = payload?.data?.object?.from
    || payload?.data?.from
    || payload?.from
    || '';

  if (!messageBody || !fromPhone) {
    console.log('[sms-reply] Missing body or from — ignoring');
    return res.status(200).json({ ignored: true });
  }

  console.log(`[sms-reply] Message from ${fromPhone}: "${messageBody}"`);

  // Identify who sent this
  const assigneeEntry = Object.entries(ASSIGNEES).find(
    ([, a]) => a.phone === fromPhone
  );

  if (!assigneeEntry) {
    console.log(`[sms-reply] Unknown sender ${fromPhone} — ignoring`);
    return res.status(200).json({ ignored: true });
  }

  const [property, assignee] = assigneeEntry;
  const { tasks } = await getOpenTasksForPhone(fromPhone);

  if (!tasks.length) {
    console.log(`[sms-reply] No open tasks for ${assignee.name}`);
    return res.status(200).json({ ok: true });
  }

  const sql = await initDb();

  // Build task list for Claude
  const taskList = tasks.map(t => `- "${t.name}" (due: ${t.due_on || 'not set'}, GID: ${t.gid})`).join('\n');

  // Ask Claude to interpret the message
  const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

  const claudeResponse = await client.messages.create({
    model: 'claude-sonnet-4-5',
    max_tokens: 1000,
    messages: [{
      role: 'user',
      content: `You are processing a text reply from a vacation rental maintenance worker named ${assignee.name}.

They replied: "${messageBody}"

Their open maintenance tasks are:
${taskList}

Today is ${today()}.

Based on their message, determine what action to take. You must respond with ONLY valid JSON in this exact format:

{
  "action": "mark_complete" | "update_date" | "schedule_followup" | "ask_clarification" | "no_action",
  "task_gid": "the GID of the task they're referring to, or null if unclear",
  "task_name": "the name of the task, or null",
  "completed_date": "YYYY-MM-DD if they said when they did it, or today's date if they said they did it without specifying, or null",
  "followup_date": "YYYY-MM-DD if they said they'll do it on a future date, or null",
  "reply_to_send": "a short reply to send back to them, or null if no reply needed",
  "reasoning": "brief explanation of your decision"
}

Rules:
- If they clearly say they did a specific task, use "mark_complete"
- If they say they did it on a past date, use "mark_complete" with that completed_date
- If they say they'll do it on a future date, use "schedule_followup" with that followup_date and send a brief confirmation reply
- If the message is too vague to identify which task (e.g. just "done" with multiple open tasks), use "ask_clarification" and ask which task in reply_to_send
- Only send a reply when absolutely necessary — don't confirm completions, don't thank them
- Keep any reply under 15 words
- If you can't match to any task, use "no_action"`
    }]
  });

  let decision;
  try {
    const raw = claudeResponse.content[0].text.replace(/```json|```/g, '').trim();
    decision = JSON.parse(raw);
  } catch (err) {
    console.error('[sms-reply] Failed to parse Claude response:', err.message);
    return res.status(200).json({ ok: true, error: 'parse_failed' });
  }

  console.log(`[sms-reply] Decision: ${decision.action} for "${decision.task_name}" — ${decision.reasoning}`);

  switch (decision.action) {
    case 'mark_complete': {
      if (!decision.task_gid) break;
      const completedDate = decision.completed_date || today();
      await markTaskComplete(decision.task_gid, completedDate);
      console.log(`[sms-reply] ✅ Marked "${decision.task_name}" complete on ${completedDate}`);
      // No reply sent — they don't need confirmation
      break;
    }

    case 'update_date': {
      if (!decision.task_gid || !decision.completed_date) break;
      await asana('PUT', `/tasks/${decision.task_gid}`, { due_on: decision.completed_date });
      console.log(`[sms-reply] 📅 Updated due date for "${decision.task_name}" to ${decision.completed_date}`);
      break;
    }

    case 'schedule_followup': {
      if (!decision.task_gid || !decision.followup_date) break;
      await sql`
        INSERT INTO sms_followups (phone, task_gid, task_name, property, followup_date)
        VALUES (${fromPhone}, ${decision.task_gid}, ${decision.task_name}, ${property}, ${decision.followup_date})
      `;
      console.log(`[sms-reply] ⏰ Follow-up scheduled for "${decision.task_name}" on ${decision.followup_date}`);
      if (decision.reply_to_send) {
        await sendSMS({ to: fromPhone, message: decision.reply_to_send });
      }
      break;
    }

    case 'ask_clarification': {
      if (decision.reply_to_send) {
        await sendSMS({ to: fromPhone, message: decision.reply_to_send });
        console.log(`[sms-reply] ❓ Sent clarification request to ${assignee.name}`);
      }
      break;
    }

    case 'no_action':
    default:
      console.log(`[sms-reply] No action taken`);
      break;
  }

  return res.status(200).json({ ok: true, action: decision.action });
}
