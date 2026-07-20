// api/weekly-report.js
// Runs every Sunday at 2pm UTC via Vercel cron.
// Emails Jordan a full maintenance status report.

import {
  getAllTasks,
  JORDAN_EMAIL,
  sendEmail,
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

  const todayStr   = today();
  const weekAgoStr = addDays(todayStr, -7);
  const next30Str  = addDays(todayStr, 30);

  console.log(`[weekly-report] Generating report for week ending ${todayStr}`);

  // Load all tasks from frequency sections grouped by property
  const allTasks = { delta_dawn: [], legobi_villa: [] };

  for (const [sectionGid, propKey] of Object.entries(FREQUENCY_SECTIONS)) {
    const tasks = await getAllTasks(sectionGid, 'gid,name,due_on,completed,completed_at,assignee.name', true);
    allTasks[propKey].push(...tasks);
  }

  const propertyData = {};
  for (const [propKey, tasks] of Object.entries(allTasks)) {
    const label = propKey === 'delta_dawn' ? '🏔️ Delta Dawn' : '🏖️ LeGobi Villa';

    const completedThisWeek = tasks.filter(t =>
      t.completed && t.completed_at &&
      t.completed_at.split('T')[0] >= weekAgoStr
    );
    const overdue = tasks.filter(t =>
      !t.completed && t.due_on && t.due_on < todayStr
    ).sort((a, b) => a.due_on.localeCompare(b.due_on));

    const upcoming = tasks.filter(t =>
      !t.completed && t.due_on &&
      t.due_on >= todayStr && t.due_on <= next30Str
    ).sort((a, b) => a.due_on.localeCompare(b.due_on));

    propertyData[propKey] = { label, completedThisWeek, overdue, upcoming };
  }

  const totalCompleted = Object.values(propertyData).reduce((s, p) => s + p.completedThisWeek.length, 0);
  const totalOverdue   = Object.values(propertyData).reduce((s, p) => s + p.overdue.length, 0);
  const totalUpcoming  = Object.values(propertyData).reduce((s, p) => s + p.upcoming.length, 0);

  const statusColor = totalOverdue > 0 ? '#e74c3c' : '#27ae60';
  const statusLabel = totalOverdue > 0 ? `${totalOverdue} task(s) overdue` : 'All clear ✅';

  const taskRow = (t, bg = '#fff') => `
    <tr style="background:${bg}">
      <td style="padding:8px 12px;">${t.name}</td>
      <td style="padding:8px 12px; white-space:nowrap;">${t.due_on ? formatDate(t.due_on) : '—'}</td>
      <td style="padding:8px 12px;">${t.assignee?.name || '—'}</td>
    </tr>`;

  const section = (title, tasks, emptyMsg) => {
    if (!tasks.length) return `
      <h3 style="margin:24px 0 8px; color:#555;">${title}</h3>
      <p style="color:#aaa; margin:0 0 16px;">${emptyMsg}</p>`;
    return `
      <h3 style="margin:24px 0 8px; color:#333;">${title}</h3>
      <table style="width:100%; border-collapse:collapse; margin-bottom:16px; font-size:14px;">
        <thead>
          <tr style="background:#f0f0f0;">
            <th style="padding:8px 12px; text-align:left;">Task</th>
            <th style="padding:8px 12px; text-align:left; white-space:nowrap;">Due Date</th>
            <th style="padding:8px 12px; text-align:left;">Assigned To</th>
          </tr>
        </thead>
        <tbody>
          ${tasks.map((t, i) => taskRow(t, i % 2 === 0 ? '#fff' : '#f9f9f9')).join('')}
        </tbody>
      </table>`;
  };

  let propertySections = '';
  for (const { label, completedThisWeek, overdue, upcoming } of Object.values(propertyData)) {
    propertySections += `
      <div style="border:1px solid #e0e0e0; border-radius:8px; padding:16px 20px; margin-bottom:24px;">
        <h2 style="margin:0 0 16px; font-size:18px;">${label}</h2>
        ${section('✅ Completed This Week', completedThisWeek, 'Nothing completed this week.')}
        ${section('🔴 Overdue', overdue, 'No overdue tasks — nice!')}
        ${section('📅 Coming Up (Next 30 Days)', upcoming, 'Nothing scheduled in the next 30 days.')}
      </div>`;
  }

  const html = `
    <div style="font-family: -apple-system, sans-serif; max-width: 680px; color: #222;">
      <div style="background:#1a1a2e; color:white; padding:20px 24px; border-radius:8px 8px 0 0;">
        <h1 style="margin:0; font-size:20px;">🏡 Dwellia Weekly Maintenance Report</h1>
        <p style="margin:4px 0 0; opacity:0.7; font-size:14px;">Week ending ${formatDate(todayStr)}</p>
      </div>
      <div style="background:${statusColor}; color:white; padding:12px 24px;">
        <span style="font-weight:600;">${statusLabel}</span>
        <span style="float:right;">${totalCompleted} completed · ${totalUpcoming} upcoming</span>
      </div>
      <div style="padding:24px;">
        ${propertySections}
        <p style="color:#aaa; font-size:12px; margin-top:32px; border-top:1px solid #eee; padding-top:16px;">
          Generated by Dwellia Maintenance Scheduler · ${todayStr}
        </p>
      </div>
    </div>`;

  await sendEmail({
    to:      JORDAN_EMAIL,
    subject: `🏡 Dwellia Maintenance Report — ${formatDate(todayStr)}`,
    html,
    text: `Dwellia Weekly Maintenance Report — ${todayStr}\nStatus: ${statusLabel}\nCompleted: ${totalCompleted} | Upcoming: ${totalUpcoming}`,
  });

  console.log(`[weekly-report] Report sent to ${JORDAN_EMAIL}`);
  return res.status(200).json({ success: true, date: todayStr, totalCompleted, totalOverdue, totalUpcoming });
}
