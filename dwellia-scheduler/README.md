# Dwellia Maintenance Scheduler

Automated maintenance scheduling for Delta Dawn and LeGobi Villa.
Reads from Asana, syncs with Hospitable booking calendar, sends SMS and email reminders.

---

## How It Works

```
Every day at 12pm UTC:
  → Reads "🗓️ Maintenance Schedule Config" project in Asana
  → Pulls checkout dates from Hospitable for next 90 days
  → For each task due within 60 days:
      → Finds nearest checkout day (so Ryan/Amanda are already on-site)
      → Creates task in the right maintenance project + section
      → Skips if an open task already exists (no duplicates)

Every day at 1pm UTC:
  → Tasks due TOMORROW → SMS reminder to Ryan or Amanda
  → Tasks due YESTERDAY that are still incomplete:
      → SMS to Ryan or Amanda
      → Email alert to Jordan

Every Sunday at 2pm UTC:
  → Weekly status email to Jordan:
      → Completed this week
      → Currently overdue
      → Coming up in next 30 days
```

---

## Setup

### 1. Clone and install
```bash
git clone https://github.com/YOUR_ORG/dwellia-scheduler.git
cd dwellia-scheduler
npm install
```

### 2. Set environment variables in Vercel

Go to your Vercel project → Settings → Environment Variables and add:

| Variable | Where to get it |
|---|---|
| `ASANA_TOKEN` | [app.asana.com/0/my-apps](https://app.asana.com/0/my-apps) → Create token |
| `HOSPITABLE_TOKEN` | Hospitable → Apps → API access → Generate token |
| `HOSPITABLE_PROPERTY_DELTA_DAWN` | Hospitable property ID for Delta Dawn |
| `HOSPITABLE_PROPERTY_LEGOBI` | Hospitable property ID for LeGobi Villa |
| `GMAIL_USER` | `jordan@liftbridgecap.com` |
| `GMAIL_APP_PASSWORD` | [myaccount.google.com/apppasswords](https://myaccount.google.com/apppasswords) |
| `QUO_API_TOKEN` | my.quo.com → Settings → API → Generate key |
| `QUO_PHONE_NUMBER_ID` | Call `GET https://api.openphone.com/v1/phone-numbers` with your token — copy the `id` field (format: `PN...`) |
| `RYAN_PHONE` | Ryan's phone in E.164 format (e.g. `+15559876543`) |
| `AMANDA_PHONE` | Amanda's phone in E.164 format |
| `SMS_ENABLED` | **Leave as `false` until you've tested.** Set to `true` when ready to send real messages. |
| `CRON_SECRET` | Any random string — keeps endpoints private |

### 3. Find your Hospitable property IDs

```bash
curl -H "Authorization: Bearer YOUR_TOKEN" https://api.hospitable.com/v1/properties
```
Look for the `id` field on each property. Add those to Vercel env vars.

### 4. Deploy to Vercel
```bash
npx vercel --prod
```

The cron jobs start immediately after deployment.

---

## Asana Schedule Config

The **🗓️ Maintenance Schedule Config** project is your control panel.

### To add a new recurring task:
1. Open the project in Asana
2. Add a task in the right section (monthly/quarterly/etc.)
3. In the task notes, include:
   ```
   FREQUENCY: 90 days
   PROPERTY: delta_dawn
   ```
   (or `legobi_villa`)
4. Set the due date = the last time this task was completed
5. Assign to Ryan (Delta Dawn) or Amanda (LeGobi)

The scheduler picks it up on the next daily run — no code changes needed.

### To update frequency:
Edit the `FREQUENCY:` line in the task notes. Changing from `90 days` to `60 days` takes effect immediately on the next run.

### To retire a task:
Mark it complete in Asana. Completed tasks are ignored by the scheduler.

### To change last-completed date:
Update the task's due date in Asana to the date it was last completed.

---

## Cron Schedule

| Endpoint | Schedule | What it does |
|---|---|---|
| `/api/scheduler` | Daily 12pm UTC | Creates maintenance tasks |
| `/api/reminders` | Daily 1pm UTC | Sends SMS/email reminders |
| `/api/weekly-report` | Sundays 2pm UTC | Emails Jordan weekly summary |

### Test an endpoint manually:
```bash
curl "https://your-app.vercel.app/api/scheduler?secret=YOUR_CRON_SECRET"
curl "https://your-app.vercel.app/api/reminders?secret=YOUR_CRON_SECRET"
curl "https://your-app.vercel.app/api/weekly-report?secret=YOUR_CRON_SECRET"
```

---

## Testing Before Going Live

### Step 1 — Test with SMS disabled (safe, no messages sent)
Deploy with `SMS_ENABLED=false` (the default). Trigger the reminders endpoint:
```bash
curl "https://your-app.vercel.app/api/reminders?secret=YOUR_CRON_SECRET"
```
Check Vercel logs — you'll see `[SMS DISABLED] Would have sent to +1xxx...` for every SMS that would have fired. Confirm the right people and messages are targeted.

### Step 2 — Test SMS to yourself first
Set `RYAN_PHONE` and `AMANDA_PHONE` both to **your own number** temporarily, then set `SMS_ENABLED=true` and trigger reminders. Verify the messages look right.

### Step 3 — Go live
Update `RYAN_PHONE` and `AMANDA_PHONE` to their real numbers. Done.

---

| File | Purpose |
|---|---|
| `api/scheduler.js` | Daily task creation from Hospitable calendar |
| `api/reminders.js` | Day-before SMS + day-after overdue alerts |
| `api/weekly-report.js` | Sunday email report to Jordan |
| `lib/utils.js` | Shared Asana, Hospitable, Gmail, Quo helpers |
| `vercel.json` | Cron schedule configuration |
| `.env.example` | All required environment variables |

---

## Asana Project IDs (hardcoded in lib/utils.js)

| Project | GID |
|---|---|
| 🗓️ Maintenance Schedule Config | `1214473265107647` |
| Delta Dawn Maintenance | `1200748932634513` |
| LeGobi Villa Maintenance | `1204026608001469` |
