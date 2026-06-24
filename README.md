# LSS 360 — Logistics Support System

Fleet and driver management system built with React + Vite + Supabase.

## Roles
- **Requester** — submit and track vehicle requests
- **Journey Manager** — approve, decline, and assign trips
- **Driver** — accept assignments, start and end trips
- **Admin** — full access to fleet, drivers, and all trips

## Project Structure

```
lss360/
├── index.html              # HTML entry point
├── vite.config.js          # Vite configuration
├── netlify.toml            # Netlify deployment config (SPA routing)
├── package.json
├── .env.example            # Copy to .env and fill in credentials
├── .gitignore
├── public/
│   └── favicon.svg
└── src/
    ├── main.jsx            # React root
    └── App.jsx             # Full application
```

## Local Development

### 1. Install dependencies
```bash
npm install
```

### 2. Set up environment variables
```bash
cp .env.example .env
```
Open `.env` and paste your Supabase credentials:
```
VITE_SUPABASE_URL=https://your-project.supabase.co
VITE_SUPABASE_ANON_KEY=eyJ...
```

### 3. Run the dev server
```bash
npm run dev
```
Opens at http://localhost:3000

## Deploy to Netlify

### Option A — Netlify CLI (fastest)
```bash
npm install -g netlify-cli
netlify login
netlify init
netlify deploy --prod
```
When prompted, set build command to `npm run build` and publish directory to `dist`.

### Option B — GitHub + Netlify Dashboard
1. Push this folder to a GitHub repository
2. Go to netlify.com → Add new site → Import from GitHub
3. Build command: `npm run build`
4. Publish directory: `dist`
5. Add environment variables in Netlify Dashboard → Site settings → Environment variables:
   - `VITE_SUPABASE_URL`
   - `VITE_SUPABASE_ANON_KEY`
6. Deploy

## Supabase Setup
Run the SQL from the DB Setup page (log in as Admin) in your Supabase SQL Editor.

## Demo Accounts (password: demo123)
| Role | Email |
|---|---|
| Requester | requester@lss.com |
| Journey Manager | jm@lss.com |
| Driver | driver@lss.com |
| Admin | admin@lss.com |
