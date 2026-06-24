import { useState, useEffect, createContext, useContext, useCallback } from "react";
import { createClient } from "@supabase/supabase-js";

// ─── SUPABASE CONFIG ─────────────────────────────────────────────────────────
// Replace with your Supabase project URL and anon key
const SUPABASE_URL = import.meta.env.VITE_SUPABASE_URL || "https://xmphnqtwjwjgwlltmjbv.supabase.co";
const SUPABASE_ANON_KEY = import.meta.env.VITE_SUPABASE_ANON_KEY || "sb_publishable_iF9QAV2NQRMG_ndkjCl4Bg_cg-Ic9FS";

const supabase = createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// ─── CONTEXT ─────────────────────────────────────────────────────────────────
const AppContext = createContext(null);
const useApp = () => useContext(AppContext);

// ─── CONSTANTS ───────────────────────────────────────────────────────────────
const ROLES = { REQUESTER: "requester", JM: "journey_manager", DRIVER: "driver", ADMIN: "admin" };

const TRIP_STATUS = {
  PENDING: "pending",
  APPROVED: "approved",
  ASSIGNED: "assigned",
  IN_PROGRESS: "in_progress",
  COMPLETED: "completed",
  DECLINED: "declined",
  CANCELLED: "cancelled",
};

const STATUS_CONFIG = {
  pending:     { label: "Pending",     color: "#F59E0B", bg: "#FEF3C7", icon: "⏳" },
  approved:    { label: "Approved",    color: "#3B82F6", bg: "#DBEAFE", icon: "✅" },
  assigned:    { label: "Assigned",    color: "#8B5CF6", bg: "#EDE9FE", icon: "🚗" },
  in_progress: { label: "In Progress", color: "#10B981", bg: "#D1FAE5", icon: "🛣️" },
  completed:   { label: "Completed",   color: "#059669", bg: "#A7F3D0", icon: "🏁" },
  declined:    { label: "Declined",    color: "#EF4444", bg: "#FEE2E2", icon: "❌" },
  cancelled:   { label: "Cancelled",   color: "#6B7280", bg: "#F3F4F6", icon: "🚫" },
};

const TRIP_STAGES = ["pending", "approved", "assigned", "in_progress", "completed"];

// ─── DATABASE SETUP SQL (for reference / Supabase SQL editor) ────────────────
const DB_SETUP_SQL = `
-- Run this in your Supabase SQL Editor

-- Profiles table
CREATE TABLE IF NOT EXISTS profiles (
  id UUID REFERENCES auth.users(id) PRIMARY KEY,
  full_name TEXT NOT NULL,
  email TEXT UNIQUE NOT NULL,
  phone TEXT,
  role TEXT NOT NULL DEFAULT 'requester' CHECK (role IN ('requester','journey_manager','driver','admin')),
  department TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Vehicles table
CREATE TABLE IF NOT EXISTS vehicles (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  plate_number TEXT UNIQUE NOT NULL,
  make TEXT NOT NULL,
  model TEXT NOT NULL,
  vehicle_type TEXT NOT NULL DEFAULT 'sedan',
  capacity INTEGER NOT NULL DEFAULT 4,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','in_use','maintenance','retired')),
  fuel_type TEXT DEFAULT 'petrol',
  year INTEGER,
  color TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Drivers table
CREATE TABLE IF NOT EXISTS drivers (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  profile_id UUID REFERENCES profiles(id),
  license_number TEXT UNIQUE NOT NULL,
  license_expiry DATE,
  status TEXT NOT NULL DEFAULT 'available' CHECK (status IN ('available','on_trip','off_duty','suspended')),
  total_trips INTEGER DEFAULT 0,
  rating NUMERIC(3,2) DEFAULT 0,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trips table
CREATE TABLE IF NOT EXISTS trips (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trip_id TEXT UNIQUE NOT NULL,
  requester_id UUID REFERENCES profiles(id),
  pickup_location TEXT NOT NULL,
  destination TEXT NOT NULL,
  trip_type TEXT NOT NULL DEFAULT 'one_way' CHECK (trip_type IN ('one_way','round_trip','multi_stop')),
  trip_date DATE NOT NULL,
  trip_time TIME NOT NULL,
  purpose TEXT NOT NULL,
  passengers INTEGER NOT NULL DEFAULT 1,
  return_schedule TIMESTAMPTZ,
  within_city BOOLEAN DEFAULT TRUE,
  status TEXT NOT NULL DEFAULT 'pending',
  driver_id UUID REFERENCES drivers(id),
  vehicle_id UUID REFERENCES vehicles(id),
  jm_notes TEXT,
  declined_reason TEXT,
  started_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT NOW(),
  updated_at TIMESTAMPTZ DEFAULT NOW()
);

-- Trip feedback table
CREATE TABLE IF NOT EXISTS trip_feedback (
  id UUID DEFAULT gen_random_uuid() PRIMARY KEY,
  trip_id UUID REFERENCES trips(id),
  submitted_by UUID REFERENCES profiles(id),
  rating INTEGER NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment TEXT,
  created_at TIMESTAMPTZ DEFAULT NOW()
);

-- Enable RLS
ALTER TABLE profiles ENABLE ROW LEVEL SECURITY;
ALTER TABLE vehicles ENABLE ROW LEVEL SECURITY;
ALTER TABLE drivers ENABLE ROW LEVEL SECURITY;
ALTER TABLE trips ENABLE ROW LEVEL SECURITY;
ALTER TABLE trip_feedback ENABLE ROW LEVEL SECURITY;

-- Basic RLS policies (open for authenticated users — tighten per role in production)
CREATE POLICY "Authenticated read profiles" ON profiles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Self update profile" ON profiles FOR UPDATE TO authenticated USING (auth.uid() = id);
CREATE POLICY "Authenticated read vehicles" ON vehicles FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read drivers" ON drivers FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated read trips" ON trips FOR SELECT TO authenticated USING (true);
CREATE POLICY "Requesters insert trips" ON trips FOR INSERT TO authenticated WITH CHECK (requester_id = auth.uid());
CREATE POLICY "Authenticated update trips" ON trips FOR UPDATE TO authenticated USING (true);
CREATE POLICY "Authenticated read feedback" ON trip_feedback FOR SELECT TO authenticated USING (true);
CREATE POLICY "Authenticated insert feedback" ON trip_feedback FOR INSERT TO authenticated WITH CHECK (submitted_by = auth.uid());
CREATE POLICY "Admin manage vehicles" ON vehicles FOR ALL TO authenticated USING (true);
CREATE POLICY "Admin manage drivers" ON drivers FOR ALL TO authenticated USING (true);

-- Function to auto-update updated_at
CREATE OR REPLACE FUNCTION handle_updated_at()
RETURNS TRIGGER AS $$ BEGIN NEW.updated_at = NOW(); RETURN NEW; END; $$ LANGUAGE plpgsql;
CREATE TRIGGER trips_updated_at BEFORE UPDATE ON trips FOR EACH ROW EXECUTE FUNCTION handle_updated_at();
`;

// ─── UTILITIES ───────────────────────────────────────────────────────────────
const generateTripId = () => {
  const date = new Date();
  const y = date.getFullYear().toString().slice(-2);
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  const rand = Math.random().toString(36).substring(2, 6).toUpperCase();
  return `LSS-${y}${m}${d}-${rand}`;
};

const fmtDate = (dt) => {
  if (!dt) return "—";
  return new Date(dt).toLocaleDateString("en-GB", { day: "2-digit", month: "short", year: "numeric" });
};

const fmtDateTime = (dt) => {
  if (!dt) return "—";
  return new Date(dt).toLocaleString("en-GB", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" });
};

const roleLabel = (role) => ({
  requester: "Requester",
  journey_manager: "Journey Manager",
  driver: "Driver",
  admin: "Administrator",
}[role] || role);

// ─── STYLES ───────────────────────────────────────────────────────────────────
const css = `
  @import url('https://fonts.googleapis.com/css2?family=Inter:wght@300;400;500;600;700;800&family=JetBrains+Mono:wght@400;500&display=swap');

  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }

  :root {
    --navy: #0F1B2D;
    --slate: #1E2D40;
    --slate-light: #253345;
    --sky: #3B82F6;
    --sky-dark: #2563EB;
    --amber: #F59E0B;
    --emerald: #10B981;
    --red: #EF4444;
    --ghost: #94A3B8;
    --border: #2D3F52;
    --text-primary: #F1F5F9;
    --text-secondary: #94A3B8;
    --text-muted: #64748B;
    --surface: #1E2D40;
    --surface-2: #253345;
    --surface-3: #2D3F52;
    --sidebar-w: 240px;
    --topbar-h: 60px;
    --radius: 10px;
    --radius-sm: 6px;
    --shadow: 0 4px 24px rgba(0,0,0,0.4);
    --shadow-sm: 0 2px 8px rgba(0,0,0,0.3);
  }

  body { font-family: 'Inter', sans-serif; background: var(--navy); color: var(--text-primary); min-height: 100vh; }

  /* ── Layout ── */
  .app-shell { display: flex; min-height: 100vh; }
  .sidebar {
    width: var(--sidebar-w); min-height: 100vh; background: var(--slate);
    border-right: 1px solid var(--border); display: flex; flex-direction: column;
    position: fixed; top: 0; left: 0; z-index: 100; transition: transform 0.25s ease;
  }
  .sidebar.collapsed { transform: translateX(calc(-1 * var(--sidebar-w))); }
  .main-area { margin-left: var(--sidebar-w); flex: 1; display: flex; flex-direction: column; min-height: 100vh; transition: margin-left 0.25s; }
  .main-area.full { margin-left: 0; }
  .topbar {
    height: var(--topbar-h); background: var(--slate); border-bottom: 1px solid var(--border);
    display: flex; align-items: center; padding: 0 24px; gap: 16px;
    position: sticky; top: 0; z-index: 50;
  }
  .page-content { padding: 28px 32px; flex: 1; }

  /* ── Sidebar ── */
  .sidebar-logo { padding: 20px 20px 16px; border-bottom: 1px solid var(--border); }
  .logo-mark { display: flex; align-items: center; gap: 10px; }
  .logo-icon {
    width: 36px; height: 36px; background: var(--sky); border-radius: 8px;
    display: flex; align-items: center; justify-content: center; font-size: 18px;
  }
  .logo-text { font-size: 18px; font-weight: 800; letter-spacing: -0.5px; color: var(--text-primary); }
  .logo-sub { font-size: 10px; color: var(--ghost); font-weight: 500; letter-spacing: 1px; text-transform: uppercase; margin-top: 2px; }

  .sidebar-nav { flex: 1; padding: 12px 10px; overflow-y: auto; }
  .nav-section { margin-bottom: 20px; }
  .nav-section-label { font-size: 10px; font-weight: 600; letter-spacing: 1.2px; text-transform: uppercase; color: var(--text-muted); padding: 6px 10px 4px; }
  .nav-item {
    display: flex; align-items: center; gap: 10px; padding: 9px 10px; border-radius: var(--radius-sm);
    cursor: pointer; transition: all 0.15s; color: var(--text-secondary); font-size: 13.5px; font-weight: 500;
    border: 1px solid transparent; margin-bottom: 2px; text-decoration: none;
  }
  .nav-item:hover { background: var(--slate-light); color: var(--text-primary); }
  .nav-item.active { background: rgba(59,130,246,0.15); color: var(--sky); border-color: rgba(59,130,246,0.25); }
  .nav-item .nav-icon { font-size: 16px; width: 20px; text-align: center; flex-shrink: 0; }
  .nav-badge { margin-left: auto; background: var(--sky); color: white; font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 10px; }

  .sidebar-footer { padding: 14px; border-top: 1px solid var(--border); }
  .user-card { display: flex; align-items: center; gap: 10px; padding: 8px; border-radius: var(--radius-sm); }
  .avatar {
    width: 34px; height: 34px; border-radius: 50%; background: var(--sky);
    display: flex; align-items: center; justify-content: center; font-size: 13px; font-weight: 700; flex-shrink: 0;
  }
  .user-info .user-name { font-size: 13px; font-weight: 600; color: var(--text-primary); }
  .user-info .user-role { font-size: 11px; color: var(--ghost); }
  .signout-btn {
    margin-top: 8px; width: 100%; padding: 8px; background: transparent; border: 1px solid var(--border);
    color: var(--text-secondary); border-radius: var(--radius-sm); cursor: pointer; font-size: 12px;
    font-family: inherit; transition: all 0.15s;
  }
  .signout-btn:hover { background: rgba(239,68,68,0.1); border-color: rgba(239,68,68,0.4); color: var(--red); }

  /* ── Topbar ── */
  .menu-toggle { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 20px; padding: 4px; }
  .page-title { font-size: 16px; font-weight: 700; color: var(--text-primary); }
  .topbar-right { margin-left: auto; display: flex; align-items: center; gap: 12px; }
  .role-badge {
    padding: 4px 10px; border-radius: 20px; font-size: 11px; font-weight: 600; letter-spacing: 0.5px;
    background: rgba(59,130,246,0.15); color: var(--sky); border: 1px solid rgba(59,130,246,0.3);
  }

  /* ── Cards ── */
  .card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 20px; box-shadow: var(--shadow-sm);
  }
  .card-title { font-size: 14px; font-weight: 700; color: var(--text-primary); margin-bottom: 4px; }
  .card-subtitle { font-size: 12px; color: var(--text-secondary); }

  /* ── Stat Cards ── */
  .stats-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(200px, 1fr)); gap: 16px; margin-bottom: 24px; }
  .stat-card {
    background: var(--surface); border: 1px solid var(--border); border-radius: var(--radius);
    padding: 20px; position: relative; overflow: hidden;
  }
  .stat-card::before {
    content: ''; position: absolute; top: 0; left: 0; right: 0; height: 3px;
    background: var(--accent-color, var(--sky));
  }
  .stat-value { font-size: 32px; font-weight: 800; color: var(--text-primary); line-height: 1; margin: 8px 0 4px; }
  .stat-label { font-size: 12px; color: var(--text-secondary); font-weight: 500; }
  .stat-icon { font-size: 28px; margin-bottom: 4px; }

  /* ── Tables ── */
  .table-wrap { overflow-x: auto; border-radius: var(--radius); border: 1px solid var(--border); }
  table { width: 100%; border-collapse: collapse; background: var(--surface); }
  thead { background: var(--slate-light); }
  th { padding: 11px 14px; text-align: left; font-size: 11px; font-weight: 600; letter-spacing: 0.8px; text-transform: uppercase; color: var(--text-secondary); white-space: nowrap; }
  td { padding: 12px 14px; border-top: 1px solid var(--border); font-size: 13px; color: var(--text-primary); }
  tr:hover td { background: rgba(255,255,255,0.02); }
  .mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }

  /* ── Status badges ── */
  .status-badge {
    display: inline-flex; align-items: center; gap: 5px; padding: 3px 9px;
    border-radius: 20px; font-size: 11px; font-weight: 600; white-space: nowrap;
  }

  /* ── Forms ── */
  .form-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 16px; }
  .form-group { display: flex; flex-direction: column; gap: 6px; }
  .form-group.full { grid-column: 1 / -1; }
  label { font-size: 12px; font-weight: 600; color: var(--text-secondary); letter-spacing: 0.3px; }
  input, select, textarea {
    background: var(--surface-2); border: 1px solid var(--border); border-radius: var(--radius-sm);
    color: var(--text-primary); font-family: inherit; font-size: 13px; padding: 9px 12px;
    transition: border-color 0.15s; outline: none; width: 100%;
  }
  input:focus, select:focus, textarea:focus { border-color: var(--sky); box-shadow: 0 0 0 3px rgba(59,130,246,0.12); }
  textarea { resize: vertical; min-height: 80px; }
  select option { background: var(--slate); }
  .input-hint { font-size: 11px; color: var(--text-muted); }

  /* ── Buttons ── */
  .btn {
    display: inline-flex; align-items: center; gap: 6px; padding: 9px 16px;
    border-radius: var(--radius-sm); font-family: inherit; font-size: 13px; font-weight: 600;
    cursor: pointer; border: none; transition: all 0.15s; white-space: nowrap;
  }
  .btn-primary { background: var(--sky); color: white; }
  .btn-primary:hover { background: var(--sky-dark); }
  .btn-success { background: var(--emerald); color: white; }
  .btn-success:hover { background: #059669; }
  .btn-danger { background: var(--red); color: white; }
  .btn-danger:hover { background: #DC2626; }
  .btn-warning { background: var(--amber); color: #1A1A1A; }
  .btn-warning:hover { background: #D97706; }
  .btn-ghost { background: transparent; color: var(--text-secondary); border: 1px solid var(--border); }
  .btn-ghost:hover { background: var(--surface-2); color: var(--text-primary); }
  .btn-sm { padding: 6px 12px; font-size: 12px; }
  .btn:disabled { opacity: 0.5; cursor: not-allowed; }

  /* ── Modal ── */
  .modal-overlay {
    position: fixed; inset: 0; background: rgba(0,0,0,0.7); z-index: 1000;
    display: flex; align-items: center; justify-content: center; padding: 20px;
    backdrop-filter: blur(4px);
  }
  .modal {
    background: var(--slate); border: 1px solid var(--border); border-radius: 14px;
    width: 100%; max-width: 680px; max-height: 90vh; overflow-y: auto;
    box-shadow: var(--shadow);
  }
  .modal-header { padding: 20px 24px; border-bottom: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between; }
  .modal-title { font-size: 16px; font-weight: 700; }
  .modal-body { padding: 24px; }
  .modal-footer { padding: 16px 24px; border-top: 1px solid var(--border); display: flex; gap: 10px; justify-content: flex-end; }
  .close-btn { background: none; border: none; color: var(--text-secondary); cursor: pointer; font-size: 20px; line-height: 1; }
  .close-btn:hover { color: var(--text-primary); }

  /* ── Trip Stepper ── */
  .trip-stepper { display: flex; align-items: flex-start; gap: 0; margin: 20px 0; }
  .step { flex: 1; display: flex; flex-direction: column; align-items: center; position: relative; }
  .step:not(:last-child)::after {
    content: ''; position: absolute; top: 14px; left: 50%; width: 100%; height: 2px;
    background: var(--border); z-index: 0;
  }
  .step.done:not(:last-child)::after { background: var(--sky); }
  .step-dot {
    width: 28px; height: 28px; border-radius: 50%; border: 2px solid var(--border); background: var(--slate);
    display: flex; align-items: center; justify-content: center; font-size: 11px; font-weight: 700;
    z-index: 1; position: relative; color: var(--text-muted);
  }
  .step.done .step-dot { background: var(--sky); border-color: var(--sky); color: white; }
  .step.current .step-dot { border-color: var(--sky); color: var(--sky); box-shadow: 0 0 0 4px rgba(59,130,246,0.2); }
  .step-label { font-size: 10px; font-weight: 600; color: var(--text-muted); margin-top: 6px; text-align: center; white-space: nowrap; }
  .step.done .step-label, .step.current .step-label { color: var(--text-secondary); }

  /* ── Empty state ── */
  .empty-state { text-align: center; padding: 60px 20px; }
  .empty-icon { font-size: 48px; margin-bottom: 16px; }
  .empty-title { font-size: 16px; font-weight: 700; color: var(--text-primary); margin-bottom: 8px; }
  .empty-desc { font-size: 13px; color: var(--text-secondary); max-width: 320px; margin: 0 auto 20px; }

  /* ── Alerts ── */
  .alert { padding: 12px 16px; border-radius: var(--radius-sm); margin-bottom: 16px; font-size: 13px; display: flex; gap: 10px; align-items: flex-start; }
  .alert-error { background: rgba(239,68,68,0.12); border: 1px solid rgba(239,68,68,0.3); color: #FCA5A5; }
  .alert-success { background: rgba(16,185,129,0.12); border: 1px solid rgba(16,185,129,0.3); color: #6EE7B7; }
  .alert-info { background: rgba(59,130,246,0.12); border: 1px solid rgba(59,130,246,0.3); color: #93C5FD; }
  .alert-warning { background: rgba(245,158,11,0.12); border: 1px solid rgba(245,158,11,0.3); color: #FCD34D; }

  /* ── Detail rows ── */
  .detail-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(220px, 1fr)); gap: 16px; }
  .detail-item { }
  .detail-label { font-size: 11px; font-weight: 600; color: var(--text-muted); text-transform: uppercase; letter-spacing: 0.8px; margin-bottom: 4px; }
  .detail-value { font-size: 14px; color: var(--text-primary); font-weight: 500; }

  /* ── Star rating ── */
  .star-rating { display: flex; gap: 4px; }
  .star { font-size: 24px; cursor: pointer; transition: transform 0.1s; filter: grayscale(1) brightness(0.5); }
  .star.active { filter: none; transform: scale(1.1); }

  /* ── Page header ── */
  .page-header { display: flex; align-items: center; justify-content: space-between; margin-bottom: 24px; gap: 16px; flex-wrap: wrap; }
  .page-header-left .page-h1 { font-size: 22px; font-weight: 800; color: var(--text-primary); }
  .page-header-left .page-h1-sub { font-size: 13px; color: var(--text-secondary); margin-top: 2px; }

  /* ── Tabs ── */
  .tabs { display: flex; gap: 4px; background: var(--surface-2); padding: 4px; border-radius: var(--radius-sm); margin-bottom: 20px; }
  .tab { padding: 7px 16px; border-radius: 6px; font-size: 13px; font-weight: 600; cursor: pointer; color: var(--text-secondary); transition: all 0.15s; }
  .tab.active { background: var(--slate); color: var(--text-primary); box-shadow: var(--shadow-sm); }
  .tab:hover:not(.active) { color: var(--text-primary); }

  /* ── Section divider ── */
  .section-divider { height: 1px; background: var(--border); margin: 20px 0; }
  .section-title { font-size: 12px; font-weight: 700; color: var(--text-muted); text-transform: uppercase; letter-spacing: 1px; margin-bottom: 14px; }

  /* ── Setup/Auth ── */
  .auth-screen {
    min-height: 100vh; display: flex; align-items: center; justify-content: center;
    background: var(--navy); padding: 20px;
  }
  .auth-card {
    background: var(--slate); border: 1px solid var(--border); border-radius: 16px;
    padding: 40px; width: 100%; max-width: 420px; box-shadow: var(--shadow);
  }
  .auth-logo { text-align: center; margin-bottom: 32px; }
  .auth-logo .logo-big { font-size: 32px; font-weight: 900; color: var(--text-primary); letter-spacing: -1px; }
  .auth-logo .logo-big span { color: var(--sky); }
  .auth-logo .logo-tagline { font-size: 12px; color: var(--ghost); margin-top: 4px; letter-spacing: 1px; text-transform: uppercase; }

  /* ── Loading ── */
  .spinner { display: inline-block; width: 18px; height: 18px; border: 2px solid rgba(255,255,255,0.3); border-top-color: white; border-radius: 50%; animation: spin 0.7s linear infinite; }
  @keyframes spin { to { transform: rotate(360deg); } }
  .loading-full { min-height: 200px; display: flex; align-items: center; justify-content: center; }

  /* ── Responsive ── */
  @media (max-width: 768px) {
    .sidebar { transform: translateX(calc(-1 * var(--sidebar-w))); }
    .sidebar.open { transform: translateX(0); }
    .main-area { margin-left: 0; }
    .page-content { padding: 16px; }
    .stats-grid { grid-template-columns: repeat(2, 1fr); }
    .form-grid { grid-template-columns: 1fr; }
    .detail-grid { grid-template-columns: 1fr 1fr; }
  }

  /* ── Misc ── */
  .flex { display: flex; }
  .flex-col { flex-direction: column; }
  .items-center { align-items: center; }
  .justify-between { justify-content: space-between; }
  .gap-2 { gap: 8px; }
  .gap-3 { gap: 12px; }
  .gap-4 { gap: 16px; }
  .mt-1 { margin-top: 4px; }
  .mt-2 { margin-top: 8px; }
  .mt-3 { margin-top: 12px; }
  .mt-4 { margin-top: 16px; }
  .mb-2 { margin-bottom: 8px; }
  .mb-3 { margin-bottom: 12px; }
  .mb-4 { margin-bottom: 16px; }
  .text-sm { font-size: 12px; }
  .text-muted { color: var(--text-muted); }
  .text-secondary { color: var(--text-secondary); }
  .font-mono { font-family: 'JetBrains Mono', monospace; font-size: 12px; }
  .w-full { width: 100%; }
  .pill { display: inline-block; padding: 2px 8px; border-radius: 20px; font-size: 11px; font-weight: 600; }
  .scrollable { overflow-y: auto; max-height: 400px; }

  /* code block */
  .code-block { background: #0A1628; border: 1px solid var(--border); border-radius: var(--radius); padding: 16px; font-family: 'JetBrains Mono', monospace; font-size: 11px; color: #7DD3FC; line-height: 1.6; overflow: auto; max-height: 500px; white-space: pre; }
`;

// ─── DEMO DATA ────────────────────────────────────────────────────────────────
// Used for demo mode (no Supabase)
const DEMO_USERS = {
  "requester@lss.com": { id: "u1", full_name: "Adaeze Okafor", role: "requester", department: "Finance", email: "requester@lss.com" },
  "jm@lss.com":        { id: "u2", full_name: "Emeka Nwachukwu", role: "journey_manager", department: "Logistics", email: "jm@lss.com" },
  "driver@lss.com":    { id: "u3", full_name: "Chukwudi Eze", role: "driver", department: "Operations", email: "driver@lss.com" },
  "admin@lss.com":     { id: "u4", full_name: "Ngozi Obi", role: "admin", department: "Admin", email: "admin@lss.com" },
};

const DEMO_VEHICLES = [
  { id: "v1", plate_number: "LSS-001-AA", make: "Toyota", model: "Land Cruiser", vehicle_type: "SUV", capacity: 5, status: "available", fuel_type: "diesel", year: 2022, color: "White" },
  { id: "v2", plate_number: "LSS-002-AB", make: "Toyota", model: "Camry", vehicle_type: "Sedan", capacity: 4, status: "available", fuel_type: "petrol", year: 2023, color: "Silver" },
  { id: "v3", plate_number: "LSS-003-AC", make: "Ford", model: "Transit", vehicle_type: "Van", capacity: 12, status: "in_use", fuel_type: "diesel", year: 2021, color: "White" },
  { id: "v4", plate_number: "LSS-004-AD", make: "Toyota", model: "HiAce", vehicle_type: "Minibus", capacity: 15, status: "maintenance", fuel_type: "diesel", year: 2020, color: "Blue" },
];

const DEMO_DRIVERS = [
  { id: "d1", profile_id: "u3", license_number: "NG-DL-2024-001", license_expiry: "2026-12-31", status: "available", total_trips: 128, rating: 4.8, profile: { full_name: "Chukwudi Eze", phone: "+234 801 234 5678", email: "driver@lss.com" } },
  { id: "d2", profile_id: "u5", license_number: "NG-DL-2023-045", license_expiry: "2025-12-31", status: "available", total_trips: 76, rating: 4.5, profile: { full_name: "Tunde Adeyemi", phone: "+234 802 345 6789", email: "tunde@lss.com" } },
  { id: "d3", profile_id: "u6", license_number: "NG-DL-2022-112", license_expiry: "2027-06-30", status: "on_trip", total_trips: 210, rating: 4.9, profile: { full_name: "Segun Olatunji", phone: "+234 803 456 7890", email: "segun@lss.com" } },
];

const initDemoTrips = () => [
  {
    id: "t1", trip_id: "LSS-260601-ABCD", requester_id: "u1",
    pickup_location: "NLNG HQ, Plot 1, Finima", destination: "Port Harcourt Airport",
    trip_type: "one_way", trip_date: "2026-06-25", trip_time: "08:00",
    purpose: "Executive airport transfer", passengers: 2, within_city: false,
    status: "approved", driver_id: null, vehicle_id: null,
    jm_notes: "VIP — priority handling",
    requester: { full_name: "Adaeze Okafor", department: "Finance" },
    created_at: "2026-06-24T07:00:00Z",
  },
  {
    id: "t2", trip_id: "LSS-260601-EFGH", requester_id: "u1",
    pickup_location: "NLNG Administration Block", destination: "GRA Phase 2",
    trip_type: "round_trip", trip_date: "2026-06-26", trip_time: "14:00",
    purpose: "Regulatory meeting", passengers: 3, within_city: true,
    status: "assigned", driver_id: "d1", vehicle_id: "v2",
    jm_notes: "",
    requester: { full_name: "Adaeze Okafor", department: "Finance" },
    created_at: "2026-06-23T10:00:00Z",
  },
  {
    id: "t3", trip_id: "LSS-260602-WXYZ", requester_id: "u1",
    pickup_location: "NLNG Community Hall", destination: "Bodo City",
    trip_type: "one_way", trip_date: "2026-06-24", trip_time: "09:00",
    purpose: "Community engagement", passengers: 8, within_city: false,
    status: "in_progress", driver_id: "d3", vehicle_id: "v3",
    jm_notes: "Use the Transit van",
    requester: { full_name: "Adaeze Okafor", department: "Finance" },
    created_at: "2026-06-22T08:00:00Z",
    started_at: "2026-06-24T09:10:00Z",
  },
  {
    id: "t4", trip_id: "LSS-260603-MNOP", requester_id: "u1",
    pickup_location: "NLNG Technical Block", destination: "Eleme Petrochemicals",
    trip_type: "one_way", trip_date: "2026-06-20", trip_time: "10:00",
    purpose: "Technical audit", passengers: 2, within_city: false,
    status: "completed", driver_id: "d2", vehicle_id: "v1",
    requester: { full_name: "Adaeze Okafor", department: "Finance" },
    created_at: "2026-06-18T09:00:00Z",
    completed_at: "2026-06-20T16:00:00Z",
  },
];

// ─── COMPONENTS ───────────────────────────────────────────────────────────────

const StatusBadge = ({ status }) => {
  const cfg = STATUS_CONFIG[status] || { label: status, color: "#94A3B8", bg: "#1E2D40" };
  return (
    <span className="status-badge" style={{ color: cfg.color, background: cfg.bg + "33", border: `1px solid ${cfg.color}44` }}>
      {cfg.icon} {cfg.label}
    </span>
  );
};

const TripStepper = ({ status }) => {
  const idx = TRIP_STAGES.indexOf(status);
  const declined = status === "declined" || status === "cancelled";
  return (
    <div className="trip-stepper">
      {TRIP_STAGES.map((s, i) => {
        const done = declined ? false : i < idx;
        const current = declined ? false : i === idx;
        const labels = { pending: "Requested", approved: "Approved", assigned: "Assigned", in_progress: "En Route", completed: "Done" };
        return (
          <div key={s} className={`step ${done ? "done" : ""} ${current ? "current" : ""}`}>
            <div className="step-dot">{done ? "✓" : i + 1}</div>
            <div className="step-label">{labels[s]}</div>
          </div>
        );
      })}
    </div>
  );
};

const StarRating = ({ value, onChange }) => (
  <div className="star-rating">
    {[1,2,3,4,5].map(s => (
      <span key={s} className={`star ${s <= value ? "active" : ""}`} onClick={() => onChange && onChange(s)}>⭐</span>
    ))}
  </div>
);

const Modal = ({ title, onClose, children, footer }) => (
  <div className="modal-overlay" onClick={e => e.target === e.currentTarget && onClose()}>
    <div className="modal">
      <div className="modal-header">
        <div className="modal-title">{title}</div>
        <button className="close-btn" onClick={onClose}>×</button>
      </div>
      <div className="modal-body">{children}</div>
      {footer && <div className="modal-footer">{footer}</div>}
    </div>
  </div>
);

// ─── AUTH ──────────────────────────────────────────────────────────────────────
const AuthScreen = ({ onLogin }) => {
  const [email, setEmail] = useState("requester@lss.com");
  const [password, setPassword] = useState("demo123");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [mode, setMode] = useState("login");
  const [regName, setRegName] = useState("");
  const [regRole, setRegRole] = useState("requester");

  const demoAccounts = [
    { role: "Requester", email: "requester@lss.com" },
    { role: "Journey Manager", email: "jm@lss.com" },
    { role: "Driver", email: "driver@lss.com" },
    { role: "Admin", email: "admin@lss.com" },
  ];

  const handleLogin = async (e) => {
    e.preventDefault();
    setLoading(true); setError("");
    // Demo mode: check against demo users
    const demo = DEMO_USERS[email.toLowerCase()];
    if (demo && password === "demo123") {
      setTimeout(() => { setLoading(false); onLogin(demo); }, 600);
      return;
    }
    // Supabase auth
    try {
      const { data, error: authErr } = await supabase.auth.signInWithPassword({ email, password });
      if (authErr) throw authErr;
      const { data: profile } = await supabase.from("profiles").select("*").eq("id", data.user.id).single();
      if (!profile) throw new Error("Profile not found");
      onLogin(profile);
    } catch (err) {
      setError(err.message || "Login failed. Try demo credentials.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="auth-screen">
      <div className="auth-card">
        <div className="auth-logo">
          <div className="logo-big">LSS <span>360</span></div>
          <div className="logo-tagline">Logistics Support System</div>
        </div>

        {error && <div className="alert alert-error">⚠️ {error}</div>}

        <div className="alert alert-info" style={{ marginBottom: 20, fontSize: 12 }}>
          <div>
            <strong>Demo Mode</strong> — use password <span className="font-mono">demo123</span><br/>
            {demoAccounts.map(a => (
              <span key={a.email} style={{ marginRight: 8, cursor: "pointer", textDecoration: "underline" }}
                onClick={() => setEmail(a.email)}>
                {a.role}
              </span>
            ))}
          </div>
        </div>

        <form onSubmit={handleLogin}>
          <div className="form-group mb-3">
            <label>Email Address</label>
            <input type="email" value={email} onChange={e => setEmail(e.target.value)} required placeholder="you@company.com" />
          </div>
          <div className="form-group mb-4">
            <label>Password</label>
            <input type="password" value={password} onChange={e => setPassword(e.target.value)} required placeholder="••••••••" />
          </div>
          <button type="submit" className="btn btn-primary w-full" disabled={loading} style={{ justifyContent: "center" }}>
            {loading ? <><span className="spinner" /> Signing in…</> : "Sign In →"}
          </button>
        </form>
      </div>
    </div>
  );
};

// ─── NAVIGATION ───────────────────────────────────────────────────────────────
const NAV_CONFIG = {
  requester: [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "new-request", label: "New Request", icon: "➕" },
    { id: "my-trips", label: "My Trips", icon: "🗺️" },
  ],
  journey_manager: [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "pending", label: "Pending Requests", icon: "⏳" },
    { id: "all-trips", label: "All Trips", icon: "🗺️" },
    { id: "drivers", label: "Drivers", icon: "👤" },
    { id: "vehicles", label: "Vehicles", icon: "🚗" },
  ],
  driver: [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "my-assignments", label: "My Assignments", icon: "📋" },
  ],
  admin: [
    { id: "dashboard", label: "Dashboard", icon: "📊" },
    { id: "all-trips", label: "All Trips", icon: "🗺️" },
    { id: "drivers", label: "Manage Drivers", icon: "👤" },
    { id: "vehicles", label: "Manage Vehicles", icon: "🚗" },
    { id: "users", label: "Users", icon: "👥" },
    { id: "db-setup", label: "DB Setup", icon: "🔧" },
  ],
};

const Sidebar = ({ user, activePage, onNavigate, collapsed, onToggle }) => {
  const navItems = NAV_CONFIG[user.role] || [];
  const initials = user.full_name?.split(" ").map(n => n[0]).slice(0, 2).join("") || "?";

  return (
    <nav className={`sidebar ${collapsed ? "collapsed" : ""}`}>
      <div className="sidebar-logo">
        <div className="logo-mark">
          <div className="logo-icon">🚛</div>
          <div>
            <div className="logo-text">LSS 360</div>
            <div className="logo-sub">Fleet Management</div>
          </div>
        </div>
      </div>

      <div className="sidebar-nav">
        <div className="nav-section">
          <div className="nav-section-label">Navigation</div>
          {navItems.map(item => (
            <div key={item.id} className={`nav-item ${activePage === item.id ? "active" : ""}`}
              onClick={() => onNavigate(item.id)}>
              <span className="nav-icon">{item.icon}</span>
              {item.label}
            </div>
          ))}
        </div>
      </div>

      <div className="sidebar-footer">
        <div className="user-card">
          <div className="avatar">{initials}</div>
          <div className="user-info">
            <div className="user-name">{user.full_name}</div>
            <div className="user-role">{roleLabel(user.role)}</div>
          </div>
        </div>
        <button className="signout-btn" onClick={() => onNavigate("__signout__")}>
          ⬅️ Sign Out
        </button>
      </div>
    </nav>
  );
};

// ─── PAGES ────────────────────────────────────────────────────────────────────

// --- Dashboard ---
const DashboardPage = ({ user, trips, drivers, vehicles }) => {
  const myTrips = user.role === "requester" ? trips.filter(t => t.requester_id === user.id) : trips;
  const driverTrips = user.role === "driver"
    ? trips.filter(t => {
        const dr = drivers.find(d => d.profile_id === user.id);
        return dr && t.driver_id === dr.id;
      })
    : [];
  const displayTrips = user.role === "driver" ? driverTrips : myTrips;

  const stats = {
    requester: [
      { label: "My Trips", value: myTrips.length, icon: "🗺️", color: "var(--sky)" },
      { label: "Pending", value: myTrips.filter(t => t.status === "pending").length, icon: "⏳", color: "var(--amber)" },
      { label: "In Progress", value: myTrips.filter(t => t.status === "in_progress").length, icon: "🛣️", color: "var(--emerald)" },
      { label: "Completed", value: myTrips.filter(t => t.status === "completed").length, icon: "🏁", color: "#8B5CF6" },
    ],
    journey_manager: [
      { label: "Pending Approval", value: trips.filter(t => t.status === "pending").length, icon: "⏳", color: "var(--amber)" },
      { label: "Active Trips", value: trips.filter(t => ["approved","assigned","in_progress"].includes(t.status)).length, icon: "🛣️", color: "var(--emerald)" },
      { label: "Available Drivers", value: drivers.filter(d => d.status === "available").length, icon: "👤", color: "var(--sky)" },
      { label: "Available Vehicles", value: vehicles.filter(v => v.status === "available").length, icon: "🚗", color: "#8B5CF6" },
    ],
    driver: [
      { label: "Assigned Trips", value: driverTrips.filter(t => t.status === "assigned").length, icon: "📋", color: "var(--sky)" },
      { label: "In Progress", value: driverTrips.filter(t => t.status === "in_progress").length, icon: "🛣️", color: "var(--emerald)" },
      { label: "Completed", value: driverTrips.filter(t => t.status === "completed").length, icon: "🏁", color: "#8B5CF6" },
      { label: "My Rating", value: (drivers.find(d => d.profile_id === user.id)?.rating || "—").toString(), icon: "⭐", color: "var(--amber)" },
    ],
    admin: [
      { label: "Total Trips", value: trips.length, icon: "🗺️", color: "var(--sky)" },
      { label: "Active Now", value: trips.filter(t => t.status === "in_progress").length, icon: "🛣️", color: "var(--emerald)" },
      { label: "Total Drivers", value: drivers.length, icon: "👤", color: "var(--amber)" },
      { label: "Fleet Size", value: vehicles.length, icon: "🚗", color: "#8B5CF6" },
    ],
  };

  const cards = stats[user.role] || stats.admin;
  const recentTrips = [...displayTrips].sort((a, b) => new Date(b.created_at) - new Date(a.created_at)).slice(0, 5);

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-h1">Welcome, {user.full_name?.split(" ")[0]} 👋</div>
          <div className="page-h1-sub">{new Date().toLocaleDateString("en-GB", { weekday: "long", day: "numeric", month: "long", year: "numeric" })}</div>
        </div>
      </div>

      <div className="stats-grid">
        {cards.map((c, i) => (
          <div key={i} className="stat-card" style={{ "--accent-color": c.color }}>
            <div className="stat-icon">{c.icon}</div>
            <div className="stat-value">{c.value}</div>
            <div className="stat-label">{c.label}</div>
          </div>
        ))}
      </div>

      <div className="card">
        <div className="flex items-center justify-between mb-4">
          <div className="card-title">Recent Trips</div>
        </div>
        {recentTrips.length === 0 ? (
          <div className="empty-state">
            <div className="empty-icon">🗺️</div>
            <div className="empty-title">No trips yet</div>
            <div className="empty-desc">Your trip history will appear here.</div>
          </div>
        ) : (
          <div className="table-wrap">
            <table>
              <thead>
                <tr>
                  <th>Trip ID</th>
                  <th>Route</th>
                  <th>Date</th>
                  <th>Status</th>
                </tr>
              </thead>
              <tbody>
                {recentTrips.map(t => (
                  <tr key={t.id}>
                    <td><span className="mono">{t.trip_id}</span></td>
                    <td>{t.pickup_location} → {t.destination}</td>
                    <td>{fmtDate(t.trip_date)}</td>
                    <td><StatusBadge status={t.status} /></td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};

// --- New Request ---
const NewRequestPage = ({ user, onSubmit }) => {
  const [form, setForm] = useState({
    pickup_location: "", destination: "", trip_type: "one_way",
    trip_date: "", trip_time: "", purpose: "", passengers: 1,
    return_schedule: "", within_city: true,
  });
  const [loading, setLoading] = useState(false);
  const [success, setSuccess] = useState("");
  const [error, setError] = useState("");

  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const handleSubmit = async (e) => {
    e.preventDefault();
    setLoading(true); setError(""); setSuccess("");
    const trip_id = generateTripId();
    const payload = { ...form, trip_id, requester_id: user.id, status: "pending", requester: { full_name: user.full_name, department: user.department } };
    try {
      await onSubmit(payload);
      setSuccess(`Trip request submitted! Your Trip ID is: ${trip_id}`);
      setForm({ pickup_location: "", destination: "", trip_type: "one_way", trip_date: "", trip_time: "", purpose: "", passengers: 1, return_schedule: "", within_city: true });
    } catch (err) {
      setError(err.message || "Failed to submit request.");
    } finally {
      setLoading(false);
    }
  };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-h1">New Vehicle Request</div>
          <div className="page-h1-sub">Complete all required fields to submit your request</div>
        </div>
      </div>

      {success && <div className="alert alert-success">✅ {success}</div>}
      {error && <div className="alert alert-error">⚠️ {error}</div>}

      <div className="card">
        <form onSubmit={handleSubmit}>
          <div className="section-title">Trip Details</div>
          <div className="form-grid">
            <div className="form-group">
              <label>Pickup Location *</label>
              <input value={form.pickup_location} onChange={e => set("pickup_location", e.target.value)} required placeholder="e.g. NLNG Admin Block, Plot 1" />
            </div>
            <div className="form-group">
              <label>Destination *</label>
              <input value={form.destination} onChange={e => set("destination", e.target.value)} required placeholder="e.g. Port Harcourt Airport" />
            </div>
            <div className="form-group">
              <label>Trip Type *</label>
              <select value={form.trip_type} onChange={e => set("trip_type", e.target.value)}>
                <option value="one_way">One Way</option>
                <option value="round_trip">Round Trip</option>
                <option value="multi_stop">Multi-Stop</option>
              </select>
            </div>
            <div className="form-group">
              <label>Trip Date *</label>
              <input type="date" value={form.trip_date} onChange={e => set("trip_date", e.target.value)} required min={new Date().toISOString().split("T")[0]} />
            </div>
            <div className="form-group">
              <label>Pickup Time *</label>
              <input type="time" value={form.trip_time} onChange={e => set("trip_time", e.target.value)} required />
            </div>
            <div className="form-group">
              <label>Number of Passengers *</label>
              <input type="number" value={form.passengers} onChange={e => set("passengers", Number(e.target.value))} required min={1} max={50} />
            </div>
            <div className="form-group full">
              <label>Purpose of Trip *</label>
              <textarea value={form.purpose} onChange={e => set("purpose", e.target.value)} required placeholder="Briefly describe the reason for this trip..." />
            </div>
            {form.trip_type === "round_trip" && (
              <div className="form-group">
                <label>Expected Return Date & Time</label>
                <input type="datetime-local" value={form.return_schedule} onChange={e => set("return_schedule", e.target.value)} />
              </div>
            )}
            <div className="form-group">
              <label>Within City Boundary?</label>
              <select value={form.within_city ? "yes" : "no"} onChange={e => set("within_city", e.target.value === "yes")}>
                <option value="yes">Yes — within city limits</option>
                <option value="no">No — intercity / interstate</option>
              </select>
            </div>
          </div>

          <div className="section-divider" />
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 10 }}>
            <button type="button" className="btn btn-ghost" onClick={() => setForm({ pickup_location: "", destination: "", trip_type: "one_way", trip_date: "", trip_time: "", purpose: "", passengers: 1, return_schedule: "", within_city: true })}>
              Clear Form
            </button>
            <button type="submit" className="btn btn-primary" disabled={loading}>
              {loading ? <><span className="spinner" /> Submitting…</> : "Submit Request →"}
            </button>
          </div>
        </form>
      </div>
    </div>
  );
};

// --- My Trips (Requester) ---
const MyTripsPage = ({ user, trips, onCancel, onFeedback }) => {
  const myTrips = trips.filter(t => t.requester_id === user.id);
  const [selected, setSelected] = useState(null);
  const [feedbackTrip, setFeedbackTrip] = useState(null);
  const [tab, setTab] = useState("all");

  const filtered = tab === "all" ? myTrips : myTrips.filter(t => t.status === tab);
  const tabs = ["all", "pending", "approved", "assigned", "in_progress", "completed", "declined", "cancelled"];

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-h1">My Trips</div>
          <div className="page-h1-sub">{myTrips.length} total trip{myTrips.length !== 1 ? "s" : ""}</div>
        </div>
      </div>

      <div className="tabs" style={{ overflowX: "auto" }}>
        {tabs.map(t => (
          <div key={t} className={`tab ${tab === t ? "active" : ""}`} onClick={() => setTab(t)}>
            {t === "all" ? "All" : STATUS_CONFIG[t]?.label || t}
            {t !== "all" && <span style={{ marginLeft: 4 }}>({myTrips.filter(x => x.status === t).length})</span>}
          </div>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">🗺️</div>
          <div className="empty-title">No trips found</div>
          <div className="empty-desc">You don't have any {tab === "all" ? "" : tab} trips.</div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Trip ID</th>
                <th>Route</th>
                <th>Type</th>
                <th>Date</th>
                <th>Passengers</th>
                <th>Status</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {filtered.map(t => (
                <tr key={t.id}>
                  <td><span className="mono">{t.trip_id}</span></td>
                  <td>
                    <div style={{ fontSize: 13, fontWeight: 600 }}>{t.pickup_location}</div>
                    <div style={{ fontSize: 11, color: "var(--ghost)" }}>→ {t.destination}</div>
                  </td>
                  <td><span className="pill" style={{ background: "rgba(59,130,246,0.15)", color: "var(--sky)" }}>{t.trip_type.replace("_", " ")}</span></td>
                  <td>{fmtDate(t.trip_date)} {t.trip_time}</td>
                  <td>{t.passengers}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(t)}>View</button>
                      {t.status === "pending" && (
                        <button className="btn btn-danger btn-sm" onClick={() => onCancel(t.id)}>Cancel</button>
                      )}
                      {t.status === "completed" && (
                        <button className="btn btn-success btn-sm" onClick={() => setFeedbackTrip(t)}>Rate</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <Modal title={`Trip Details — ${selected.trip_id}`} onClose={() => setSelected(null)}>
          <TripStepper status={selected.status} />
          <div className="section-divider" />
          <div className="detail-grid">
            <div className="detail-item"><div className="detail-label">Pickup</div><div className="detail-value">{selected.pickup_location}</div></div>
            <div className="detail-item"><div className="detail-label">Destination</div><div className="detail-value">{selected.destination}</div></div>
            <div className="detail-item"><div className="detail-label">Date & Time</div><div className="detail-value">{fmtDate(selected.trip_date)} at {selected.trip_time}</div></div>
            <div className="detail-item"><div className="detail-label">Trip Type</div><div className="detail-value">{selected.trip_type.replace("_", " ")}</div></div>
            <div className="detail-item"><div className="detail-label">Passengers</div><div className="detail-value">{selected.passengers}</div></div>
            <div className="detail-item"><div className="detail-label">Within City</div><div className="detail-value">{selected.within_city ? "Yes" : "No"}</div></div>
            <div className="detail-item" style={{ gridColumn: "1/-1" }}><div className="detail-label">Purpose</div><div className="detail-value">{selected.purpose}</div></div>
            {selected.jm_notes && <div className="detail-item" style={{ gridColumn: "1/-1" }}><div className="detail-label">Journey Manager Notes</div><div className="detail-value">{selected.jm_notes}</div></div>}
            {selected.declined_reason && <div className="detail-item" style={{ gridColumn: "1/-1" }}><div className="detail-label">Decline Reason</div><div className="detail-value" style={{ color: "var(--red)" }}>{selected.declined_reason}</div></div>}
          </div>
        </Modal>
      )}

      {feedbackTrip && <FeedbackModal trip={feedbackTrip} user={user} onClose={() => setFeedbackTrip(null)} onSubmit={onFeedback} />}
    </div>
  );
};

// --- Feedback Modal ---
const FeedbackModal = ({ trip, user, onClose, onSubmit }) => {
  const [rating, setRating] = useState(0);
  const [comment, setComment] = useState("");
  const [loading, setLoading] = useState(false);

  const handleSubmit = async () => {
    if (!rating) return;
    setLoading(true);
    await onSubmit({ trip_id: trip.id, submitted_by: user.id, rating, comment });
    setLoading(false);
    onClose();
  };

  return (
    <Modal title="Rate Your Trip" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={handleSubmit} disabled={!rating || loading}>
          {loading ? <><span className="spinner" /> Submitting…</> : "Submit Rating"}
        </button>
      </>}>
      <div style={{ textAlign: "center", marginBottom: 20 }}>
        <div style={{ fontSize: 13, color: "var(--text-secondary)", marginBottom: 16 }}>
          {trip.trip_id} — {trip.pickup_location} → {trip.destination}
        </div>
        <div style={{ marginBottom: 8, fontWeight: 600 }}>How was your trip?</div>
        <StarRating value={rating} onChange={setRating} />
        {rating > 0 && <div style={{ marginTop: 8, fontSize: 13, color: "var(--sky)" }}>
          {["", "Poor", "Fair", "Good", "Great", "Excellent!"][rating]}
        </div>}
      </div>
      <div className="form-group">
        <label>Additional Comments (optional)</label>
        <textarea value={comment} onChange={e => setComment(e.target.value)} placeholder="Share your experience..." />
      </div>
    </Modal>
  );
};

// --- Pending Requests (Journey Manager) ---
const PendingRequestsPage = ({ trips, drivers, vehicles, onApprove, onDecline, onAssign }) => {
  const pending = trips.filter(t => t.status === "pending");
  const approved = trips.filter(t => t.status === "approved");
  const [selected, setSelected] = useState(null);
  const [assignModal, setAssignModal] = useState(null);
  const [declineModal, setDeclineModal] = useState(null);
  const [tab, setTab] = useState("pending");

  const display = tab === "pending" ? pending : approved;

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-h1">Trip Requests</div>
          <div className="page-h1-sub">Review, approve, and assign incoming requests</div>
        </div>
      </div>

      <div className="tabs">
        <div className={`tab ${tab === "pending" ? "active" : ""}`} onClick={() => setTab("pending")}>
          Pending Approval ({pending.length})
        </div>
        <div className={`tab ${tab === "approved" ? "active" : ""}`} onClick={() => setTab("approved")}>
          Approved — Awaiting Assignment ({approved.length})
        </div>
      </div>

      {display.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">{tab === "pending" ? "✅" : "🚗"}</div>
          <div className="empty-title">{tab === "pending" ? "All caught up!" : "No approved trips"}</div>
          <div className="empty-desc">{tab === "pending" ? "No pending requests right now." : "Approve requests first, then assign drivers."}</div>
        </div>
      ) : (
        <div className="table-wrap">
          <table>
            <thead>
              <tr>
                <th>Trip ID</th>
                <th>Requester</th>
                <th>Route</th>
                <th>Date</th>
                <th>Pax</th>
                <th>Type</th>
                <th>City?</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {display.map(t => (
                <tr key={t.id}>
                  <td><span className="mono">{t.trip_id}</span></td>
                  <td>
                    <div style={{ fontWeight: 600, fontSize: 13 }}>{t.requester?.full_name}</div>
                    <div style={{ fontSize: 11, color: "var(--ghost)" }}>{t.requester?.department}</div>
                  </td>
                  <td>
                    <div style={{ fontSize: 13 }}>{t.pickup_location}</div>
                    <div style={{ fontSize: 11, color: "var(--ghost)" }}>→ {t.destination}</div>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDate(t.trip_date)} {t.trip_time}</td>
                  <td>{t.passengers}</td>
                  <td>{t.trip_type.replace("_", " ")}</td>
                  <td>{t.within_city ? "✅" : "🛣️"}</td>
                  <td>
                    <div style={{ display: "flex", gap: 5, flexWrap: "wrap" }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(t)}>View</button>
                      {tab === "pending" && <>
                        <button className="btn btn-success btn-sm" onClick={() => onApprove(t.id)}>Approve</button>
                        <button className="btn btn-danger btn-sm" onClick={() => setDeclineModal(t)}>Decline</button>
                      </>}
                      {tab === "approved" && (
                        <button className="btn btn-primary btn-sm" onClick={() => setAssignModal(t)}>Assign</button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}

      {selected && (
        <Modal title={`Request — ${selected.trip_id}`} onClose={() => setSelected(null)}>
          <div className="detail-grid">
            {[
              ["Requester", selected.requester?.full_name],
              ["Department", selected.requester?.department],
              ["Pickup", selected.pickup_location],
              ["Destination", selected.destination],
              ["Date", fmtDate(selected.trip_date)],
              ["Time", selected.trip_time],
              ["Trip Type", selected.trip_type.replace("_", " ")],
              ["Passengers", selected.passengers],
              ["Within City", selected.within_city ? "Yes" : "No"],
              ["Submitted", fmtDateTime(selected.created_at)],
            ].map(([k, v]) => (
              <div className="detail-item" key={k}><div className="detail-label">{k}</div><div className="detail-value">{v}</div></div>
            ))}
            <div className="detail-item" style={{ gridColumn: "1/-1" }}><div className="detail-label">Purpose</div><div className="detail-value">{selected.purpose}</div></div>
          </div>
        </Modal>
      )}

      {declineModal && <DeclineModal trip={declineModal} onClose={() => setDeclineModal(null)} onDecline={(id, reason) => { onDecline(id, reason); setDeclineModal(null); }} />}
      {assignModal && <AssignModal trip={assignModal} drivers={drivers} vehicles={vehicles} onClose={() => setAssignModal(null)} onAssign={(tid, did, vid, notes) => { onAssign(tid, did, vid, notes); setAssignModal(null); }} />}
    </div>
  );
};

const DeclineModal = ({ trip, onClose, onDecline }) => {
  const [reason, setReason] = useState("");
  return (
    <Modal title="Decline Request" onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-danger" onClick={() => onDecline(trip.id, reason)} disabled={!reason.trim()}>Decline Request</button>
      </>}>
      <div className="alert alert-warning">You are declining trip <strong>{trip.trip_id}</strong>.</div>
      <div className="form-group">
        <label>Reason for Declining *</label>
        <textarea value={reason} onChange={e => setReason(e.target.value)} placeholder="Provide a clear reason for the requester..." required />
      </div>
    </Modal>
  );
};

const AssignModal = ({ trip, drivers, vehicles, onClose, onAssign }) => {
  const [driverId, setDriverId] = useState("");
  const [vehicleId, setVehicleId] = useState("");
  const [notes, setNotes] = useState("");
  const availDrivers = drivers.filter(d => d.status === "available");
  const availVehicles = vehicles.filter(v => v.status === "available" && v.capacity >= trip.passengers);

  return (
    <Modal title={`Assign — ${trip.trip_id}`} onClose={onClose}
      footer={<>
        <button className="btn btn-ghost" onClick={onClose}>Cancel</button>
        <button className="btn btn-primary" onClick={() => onAssign(trip.id, driverId, vehicleId, notes)} disabled={!driverId || !vehicleId}>
          Confirm Assignment
        </button>
      </>}>
      <div className="alert alert-info" style={{ marginBottom: 16, fontSize: 12 }}>
        {trip.pickup_location} → {trip.destination} • {trip.passengers} passenger{trip.passengers !== 1 ? "s" : ""}
      </div>
      <div className="form-grid">
        <div className="form-group">
          <label>Assign Driver *</label>
          <select value={driverId} onChange={e => setDriverId(e.target.value)}>
            <option value="">— Select Driver —</option>
            {availDrivers.map(d => (
              <option key={d.id} value={d.id}>{d.profile?.full_name} (⭐{d.rating} · {d.total_trips} trips)</option>
            ))}
          </select>
          <div className="input-hint">{availDrivers.length} driver{availDrivers.length !== 1 ? "s" : ""} available</div>
        </div>
        <div className="form-group">
          <label>Assign Vehicle *</label>
          <select value={vehicleId} onChange={e => setVehicleId(e.target.value)}>
            <option value="">— Select Vehicle —</option>
            {availVehicles.map(v => (
              <option key={v.id} value={v.id}>{v.plate_number} — {v.make} {v.model} ({v.capacity} seats)</option>
            ))}
          </select>
          <div className="input-hint">Showing vehicles with ≥{trip.passengers} seat capacity</div>
        </div>
        <div className="form-group full">
          <label>Notes to Driver</label>
          <textarea value={notes} onChange={e => setNotes(e.target.value)} placeholder="Any special instructions for the driver..." />
        </div>
      </div>
    </Modal>
  );
};

// --- All Trips (JM / Admin) ---
const AllTripsPage = ({ trips, drivers, vehicles, onApprove, onDecline, onAssign }) => {
  const [tab, setTab] = useState("all");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState(null);
  const [assignModal, setAssignModal] = useState(null);
  const [declineModal, setDeclineModal] = useState(null);

  const filtered = trips.filter(t => {
    const matchTab = tab === "all" || t.status === tab;
    const matchSearch = !search || [t.trip_id, t.pickup_location, t.destination, t.requester?.full_name].some(f => f?.toLowerCase().includes(search.toLowerCase()));
    return matchTab && matchSearch;
  });

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-h1">All Trips</div>
          <div className="page-h1-sub">{trips.length} total trips in the system</div>
        </div>
        <input value={search} onChange={e => setSearch(e.target.value)} placeholder="🔍 Search trips…" style={{ width: 240 }} />
      </div>

      <div className="tabs" style={{ overflowX: "auto" }}>
        {["all", ...Object.keys(TRIP_STATUS)].map(s => {
          const key = s === "all" ? "all" : TRIP_STATUS[s];
          const count = key === "all" ? trips.length : trips.filter(t => t.status === key).length;
          return (
            <div key={key} className={`tab ${tab === key ? "active" : ""}`} onClick={() => setTab(key)}>
              {key === "all" ? "All" : STATUS_CONFIG[key]?.label} ({count})
            </div>
          );
        })}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Trip ID</th>
              <th>Requester</th>
              <th>Route</th>
              <th>Date</th>
              <th>Driver</th>
              <th>Vehicle</th>
              <th>Status</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {filtered.length === 0 && (
              <tr><td colSpan={8} style={{ textAlign: "center", padding: 40, color: "var(--ghost)" }}>No trips found</td></tr>
            )}
            {filtered.map(t => {
              const dr = drivers.find(d => d.id === t.driver_id);
              const veh = vehicles.find(v => v.id === t.vehicle_id);
              return (
                <tr key={t.id}>
                  <td><span className="mono">{t.trip_id}</span></td>
                  <td>{t.requester?.full_name || "—"}</td>
                  <td>
                    <div style={{ fontSize: 13 }}>{t.pickup_location}</div>
                    <div style={{ fontSize: 11, color: "var(--ghost)" }}>→ {t.destination}</div>
                  </td>
                  <td style={{ whiteSpace: "nowrap" }}>{fmtDate(t.trip_date)}</td>
                  <td>{dr?.profile?.full_name || "—"}</td>
                  <td>{veh ? `${veh.plate_number}` : "—"}</td>
                  <td><StatusBadge status={t.status} /></td>
                  <td>
                    <div style={{ display: "flex", gap: 5 }}>
                      <button className="btn btn-ghost btn-sm" onClick={() => setSelected(t)}>View</button>
                      {t.status === "approved" && (
                        <button className="btn btn-primary btn-sm" onClick={() => setAssignModal(t)}>Assign</button>
                      )}
                      {t.status === "pending" && (
                        <button className="btn btn-danger btn-sm" onClick={() => setDeclineModal(t)}>Decline</button>
                      )}
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {selected && (
        <Modal title={`Trip — ${selected.trip_id}`} onClose={() => setSelected(null)}>
          <TripStepper status={selected.status} />
          <div className="section-divider" />
          <div className="detail-grid">
            {[
              ["Trip ID", selected.trip_id],
              ["Status", selected.status],
              ["Requester", selected.requester?.full_name],
              ["Date", `${fmtDate(selected.trip_date)} at ${selected.trip_time}`],
              ["Pickup", selected.pickup_location],
              ["Destination", selected.destination],
              ["Type", selected.trip_type],
              ["Passengers", selected.passengers],
              ["Within City", selected.within_city ? "Yes" : "No"],
              ["Started", fmtDateTime(selected.started_at)],
              ["Completed", fmtDateTime(selected.completed_at)],
            ].map(([k, v]) => (
              <div className="detail-item" key={k}>
                <div className="detail-label">{k}</div>
                <div className="detail-value">{k === "Status" ? <StatusBadge status={v} /> : v || "—"}</div>
              </div>
            ))}
            <div className="detail-item" style={{ gridColumn: "1/-1" }}><div className="detail-label">Purpose</div><div className="detail-value">{selected.purpose}</div></div>
            {selected.jm_notes && <div className="detail-item" style={{ gridColumn: "1/-1" }}><div className="detail-label">JM Notes</div><div className="detail-value">{selected.jm_notes}</div></div>}
            {selected.declined_reason && <div className="detail-item" style={{ gridColumn: "1/-1" }}><div className="detail-label">Decline Reason</div><div className="detail-value" style={{ color: "var(--red)" }}>{selected.declined_reason}</div></div>}
          </div>
        </Modal>
      )}
      {declineModal && <DeclineModal trip={declineModal} onClose={() => setDeclineModal(null)} onDecline={(id, reason) => { onDecline(id, reason); setDeclineModal(null); }} />}
      {assignModal && <AssignModal trip={assignModal} drivers={drivers} vehicles={vehicles} onClose={() => setAssignModal(null)} onAssign={(tid, did, vid, notes) => { onAssign(tid, did, vid, notes); setAssignModal(null); }} />}
    </div>
  );
};

// --- Driver Assignments ---
const DriverAssignmentsPage = ({ user, trips, drivers, vehicles, onAccept, onDecline, onStart, onEnd }) => {
  const myDriver = drivers.find(d => d.profile_id === user.id);
  const myTrips = myDriver ? trips.filter(t => t.driver_id === myDriver.id) : [];
  const [selected, setSelected] = useState(null);
  const [tab, setTab] = useState("assigned");

  const tabs = [
    { key: "assigned", label: "Assigned" },
    { key: "in_progress", label: "In Progress" },
    { key: "completed", label: "Completed" },
  ];
  const filtered = myTrips.filter(t => t.status === tab);

  if (!myDriver) {
    return (
      <div className="empty-state">
        <div className="empty-icon">🚗</div>
        <div className="empty-title">Driver profile not found</div>
        <div className="empty-desc">Your account is not linked to a driver record. Contact your administrator.</div>
      </div>
    );
  }

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-h1">My Assignments</div>
          <div className="page-h1-sub">⭐ {myDriver.rating} rating · {myDriver.total_trips} trips completed</div>
        </div>
        <div className="card" style={{ padding: "12px 16px", border: "1px solid var(--emerald)33" }}>
          <div style={{ fontSize: 11, color: "var(--text-muted)", fontWeight: 600 }}>Driver Status</div>
          <div style={{ display: "flex", alignItems: "center", gap: 8, marginTop: 4 }}>
            <div style={{ width: 8, height: 8, borderRadius: "50%", background: myDriver.status === "available" ? "var(--emerald)" : "var(--amber)" }} />
            <span style={{ fontSize: 13, fontWeight: 600, color: "var(--text-primary)" }}>
              {myDriver.status === "available" ? "Available" : myDriver.status === "on_trip" ? "On Trip" : myDriver.status}
            </span>
          </div>
        </div>
      </div>

      <div className="tabs">
        {tabs.map(t => (
          <div key={t.key} className={`tab ${tab === t.key ? "active" : ""}`} onClick={() => setTab(t.key)}>
            {t.label} ({myTrips.filter(x => x.status === t.key).length})
          </div>
        ))}
      </div>

      {filtered.length === 0 ? (
        <div className="empty-state">
          <div className="empty-icon">📋</div>
          <div className="empty-title">No {tab.replace("_", " ")} trips</div>
          <div className="empty-desc">Your {tab === "assigned" ? "new assignments" : tab === "in_progress" ? "active trips" : "past trips"} will appear here.</div>
        </div>
      ) : (
        <div style={{ display: "flex", flexDirection: "column", gap: 14 }}>
          {filtered.map(t => {
            const veh = vehicles.find(v => v.id === t.vehicle_id);
            return (
              <div key={t.id} className="card" style={{ borderLeft: `4px solid ${STATUS_CONFIG[t.status]?.color || "var(--sky)"}` }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", flexWrap: "wrap", gap: 12 }}>
                  <div>
                    <div style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
                      <span className="mono" style={{ color: "var(--sky)" }}>{t.trip_id}</span>
                      <StatusBadge status={t.status} />
                    </div>
                    <div style={{ fontSize: 15, fontWeight: 700, marginBottom: 4 }}>{t.pickup_location}</div>
                    <div style={{ fontSize: 13, color: "var(--ghost)" }}>→ {t.destination}</div>
                    <div style={{ marginTop: 10, display: "flex", gap: 16, flexWrap: "wrap" }}>
                      <div><div className="detail-label">Date</div><div style={{ fontSize: 13 }}>{fmtDate(t.trip_date)} {t.trip_time}</div></div>
                      <div><div className="detail-label">Passengers</div><div style={{ fontSize: 13 }}>{t.passengers}</div></div>
                      {veh && <div><div className="detail-label">Vehicle</div><div style={{ fontSize: 13 }}>{veh.plate_number} — {veh.make} {veh.model}</div></div>}
                      {t.jm_notes && <div><div className="detail-label">Instructions</div><div style={{ fontSize: 13, color: "var(--amber)" }}>{t.jm_notes}</div></div>}
                    </div>
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                    {t.status === "assigned" && <>
                      <button className="btn btn-success btn-sm" onClick={() => onStart(t.id)}>▶ Start Trip</button>
                      <button className="btn btn-danger btn-sm" onClick={() => onDecline(t.id)}>Decline</button>
                    </>}
                    {t.status === "in_progress" && (
                      <button className="btn btn-warning btn-sm" onClick={() => onEnd(t.id)}>🏁 End Trip</button>
                    )}
                    <button className="btn btn-ghost btn-sm" onClick={() => setSelected(t)}>Details</button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {selected && (
        <Modal title={`Trip Details — ${selected.trip_id}`} onClose={() => setSelected(null)}>
          <TripStepper status={selected.status} />
          <div className="section-divider" />
          <div className="detail-grid">
            {[
              ["Requester", selected.requester?.full_name],
              ["Purpose", selected.purpose],
              ["Pickup", selected.pickup_location],
              ["Destination", selected.destination],
              ["Date & Time", `${fmtDate(selected.trip_date)} at ${selected.trip_time}`],
              ["Passengers", selected.passengers],
              ["Trip Type", selected.trip_type],
              ["Within City", selected.within_city ? "Yes" : "No"],
            ].map(([k, v]) => (
              <div className="detail-item" key={k}><div className="detail-label">{k}</div><div className="detail-value">{v}</div></div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
};

// --- Drivers Management ---
const DriversPage = ({ drivers, vehicles, user }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ full_name: "", email: "", phone: "", license_number: "", license_expiry: "" });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const statusColors = { available: "var(--emerald)", on_trip: "var(--amber)", off_duty: "var(--ghost)", suspended: "var(--red)" };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-h1">Drivers</div>
          <div className="page-h1-sub">{drivers.length} registered drivers</div>
        </div>
        {user.role === "admin" && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Driver</button>
        )}
      </div>

      <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))", gap: 16 }}>
        {drivers.map(d => (
          <div key={d.id} className="card" style={{ borderTop: `3px solid ${statusColors[d.status] || "var(--border)"}` }}>
            <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 14 }}>
              <div className="avatar" style={{ width: 44, height: 44, fontSize: 16 }}>
                {d.profile?.full_name?.split(" ").map(n => n[0]).join("").slice(0, 2)}
              </div>
              <div>
                <div style={{ fontWeight: 700, fontSize: 15 }}>{d.profile?.full_name}</div>
                <div style={{ fontSize: 12, color: "var(--ghost)" }}>{d.profile?.email}</div>
              </div>
            </div>
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
              <div><div className="detail-label">License No.</div><div className="font-mono" style={{ fontSize: 12 }}>{d.license_number}</div></div>
              <div><div className="detail-label">Expiry</div><div style={{ fontSize: 13 }}>{fmtDate(d.license_expiry)}</div></div>
              <div><div className="detail-label">Total Trips</div><div style={{ fontSize: 18, fontWeight: 800 }}>{d.total_trips}</div></div>
              <div><div className="detail-label">Rating</div><div style={{ fontSize: 18, fontWeight: 800, color: "var(--amber)" }}>⭐ {d.rating}</div></div>
            </div>
            <div style={{ marginTop: 12, display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, fontWeight: 600, color: statusColors[d.status] || "var(--ghost)" }}>
                <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColors[d.status] || "var(--ghost)", display: "inline-block" }} />
                {d.status.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase())}
              </span>
              {d.profile?.phone && <span style={{ fontSize: 12, color: "var(--ghost)" }}>{d.profile.phone}</span>}
            </div>
          </div>
        ))}
      </div>

      {showAdd && (
        <Modal title="Add New Driver" onClose={() => setShowAdd(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => { alert("In production: creates auth user + driver record in Supabase."); setShowAdd(false); }}>
              Add Driver (Demo)
            </button>
          </>}>
          <div className="alert alert-info mb-3">In production, this creates a Supabase auth account and driver profile.</div>
          <div className="form-grid">
            {[["full_name","Full Name","text"],["email","Email","email"],["phone","Phone","tel"],["license_number","License Number","text"],["license_expiry","License Expiry","date"]].map(([k, l, t]) => (
              <div className="form-group" key={k}>
                <label>{l}</label>
                <input type={t} value={form[k]} onChange={e => set(k, e.target.value)} />
              </div>
            ))}
          </div>
        </Modal>
      )}
    </div>
  );
};

// --- Vehicles Management ---
const VehiclesPage = ({ vehicles, user }) => {
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ plate_number: "", make: "", model: "", vehicle_type: "sedan", capacity: 4, fuel_type: "petrol", year: "", color: "" });
  const set = (k, v) => setForm(f => ({ ...f, [k]: v }));

  const statusColor = { available: "var(--emerald)", in_use: "var(--amber)", maintenance: "var(--sky)", retired: "var(--ghost)" };
  const typeIcon = { sedan: "🚗", suv: "🚙", van: "🚐", minibus: "🚌", truck: "🚛" };

  return (
    <div>
      <div className="page-header">
        <div className="page-header-left">
          <div className="page-h1">Fleet</div>
          <div className="page-h1-sub">{vehicles.length} vehicles · {vehicles.filter(v => v.status === "available").length} available</div>
        </div>
        {user.role === "admin" && (
          <button className="btn btn-primary" onClick={() => setShowAdd(true)}>+ Add Vehicle</button>
        )}
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>Type</th>
              <th>Plate</th>
              <th>Vehicle</th>
              <th>Year</th>
              <th>Color</th>
              <th>Capacity</th>
              <th>Fuel</th>
              <th>Status</th>
            </tr>
          </thead>
          <tbody>
            {vehicles.map(v => (
              <tr key={v.id}>
                <td style={{ fontSize: 22 }}>{typeIcon[v.vehicle_type?.toLowerCase()] || "🚗"}</td>
                <td><span className="mono" style={{ color: "var(--sky)" }}>{v.plate_number}</span></td>
                <td><div style={{ fontWeight: 600 }}>{v.make} {v.model}</div><div style={{ fontSize: 11, color: "var(--ghost)" }}>{v.vehicle_type}</div></td>
                <td>{v.year || "—"}</td>
                <td>{v.color || "—"}</td>
                <td>{v.capacity} seats</td>
                <td>{v.fuel_type}</td>
                <td>
                  <span style={{ display: "flex", alignItems: "center", gap: 5, fontSize: 12, fontWeight: 600, color: statusColor[v.status] }}>
                    <span style={{ width: 7, height: 7, borderRadius: "50%", background: statusColor[v.status], display: "inline-block" }} />
                    {v.status.replace("_", " ").replace(/\b\w/g, c => c.toUpperCase())}
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {showAdd && (
        <Modal title="Add Vehicle" onClose={() => setShowAdd(false)}
          footer={<>
            <button className="btn btn-ghost" onClick={() => setShowAdd(false)}>Cancel</button>
            <button className="btn btn-primary" onClick={() => { alert("In production: saves to Supabase vehicles table."); setShowAdd(false); }}>
              Add Vehicle (Demo)
            </button>
          </>}>
          <div className="form-grid">
            <div className="form-group"><label>Plate Number</label><input value={form.plate_number} onChange={e => set("plate_number", e.target.value)} placeholder="LSS-001-AA" /></div>
            <div className="form-group"><label>Make</label><input value={form.make} onChange={e => set("make", e.target.value)} placeholder="Toyota" /></div>
            <div className="form-group"><label>Model</label><input value={form.model} onChange={e => set("model", e.target.value)} placeholder="Land Cruiser" /></div>
            <div className="form-group">
              <label>Type</label>
              <select value={form.vehicle_type} onChange={e => set("vehicle_type", e.target.value)}>
                {["Sedan","SUV","Van","Minibus","Truck"].map(t => <option key={t} value={t.toLowerCase()}>{t}</option>)}
              </select>
            </div>
            <div className="form-group"><label>Capacity (seats)</label><input type="number" value={form.capacity} onChange={e => set("capacity", e.target.value)} /></div>
            <div className="form-group"><label>Fuel Type</label><select value={form.fuel_type} onChange={e => set("fuel_type", e.target.value)}><option value="petrol">Petrol</option><option value="diesel">Diesel</option><option value="electric">Electric</option></select></div>
            <div className="form-group"><label>Year</label><input type="number" value={form.year} onChange={e => set("year", e.target.value)} placeholder="2023" /></div>
            <div className="form-group"><label>Color</label><input value={form.color} onChange={e => set("color", e.target.value)} placeholder="White" /></div>
          </div>
        </Modal>
      )}
    </div>
  );
};

// --- DB Setup ---
const DBSetupPage = () => (
  <div>
    <div className="page-header">
      <div className="page-header-left">
        <div className="page-h1">Database Setup</div>
        <div className="page-h1-sub">Run this SQL in your Supabase SQL Editor to initialise all tables</div>
      </div>
    </div>
    <div className="alert alert-warning mb-4">
      ⚠️ Replace <strong>SUPABASE_URL</strong> and <strong>SUPABASE_ANON_KEY</strong> at the top of this file with your project credentials, then run the SQL below in your Supabase dashboard → SQL Editor.
    </div>
    <div className="card">
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
        <div className="card-title">Supabase Schema SQL</div>
        <button className="btn btn-ghost btn-sm" onClick={() => { navigator.clipboard.writeText(DB_SETUP_SQL); alert("Copied to clipboard!"); }}>
          📋 Copy SQL
        </button>
      </div>
      <div className="code-block">{DB_SETUP_SQL}</div>
    </div>
  </div>
);

// ─── MAIN APP ─────────────────────────────────────────────────────────────────
export default function App() {
  const [user, setUser] = useState(null);
  const [page, setPage] = useState("dashboard");
  const [sidebarOpen, setSidebarOpen] = useState(true);
  const [trips, setTrips] = useState(initDemoTrips());
  const [drivers, setDrivers] = useState(DEMO_DRIVERS);
  const [vehicles, setVehicles] = useState(DEMO_VEHICLES);
  const [pendingCount, setPendingCount] = useState(0);

  useEffect(() => {
    setPendingCount(trips.filter(t => t.status === "pending").length);
  }, [trips]);

  // Trip actions
  const addTrip = (trip) => {
    setTrips(prev => [{ ...trip, id: `t${Date.now()}`, created_at: new Date().toISOString() }, ...prev]);
  };

  const updateTrip = (id, updates) => {
    setTrips(prev => prev.map(t => t.id === id ? { ...t, ...updates } : t));
  };

  const handleApprove = (id) => updateTrip(id, { status: "approved" });

  const handleDecline = (id, declined_reason) => updateTrip(id, { status: "declined", declined_reason });

  const handleCancel = (id) => updateTrip(id, { status: "cancelled" });

  const handleAssign = (tripId, driverId, vehicleId, jm_notes) => {
    updateTrip(tripId, { status: "assigned", driver_id: driverId, vehicle_id: vehicleId, jm_notes });
    setDrivers(prev => prev.map(d => d.id === driverId ? { ...d, status: "on_trip" } : d));
    setVehicles(prev => prev.map(v => v.id === vehicleId ? { ...v, status: "in_use" } : v));
  };

  const handleDriverDecline = (id) => updateTrip(id, { status: "approved" });

  const handleStart = (id) => {
    updateTrip(id, { status: "in_progress", started_at: new Date().toISOString() });
  };

  const handleEnd = (id) => {
    const trip = trips.find(t => t.id === id);
    updateTrip(id, { status: "completed", completed_at: new Date().toISOString() });
    if (trip?.driver_id) setDrivers(prev => prev.map(d => d.id === trip.driver_id ? { ...d, status: "available", total_trips: d.total_trips + 1 } : d));
    if (trip?.vehicle_id) setVehicles(prev => prev.map(v => v.id === trip.vehicle_id ? { ...v, status: "available" } : v));
  };

  const handleFeedback = (feedback) => {
    // In production: save to trip_feedback table
    console.log("Feedback submitted:", feedback);
  };

  const handleNavigate = (p) => {
    if (p === "__signout__") { setUser(null); return; }
    setPage(p);
    if (window.innerWidth < 768) setSidebarOpen(false);
  };

  const pageTitles = {
    dashboard: "Dashboard", "new-request": "New Request", "my-trips": "My Trips",
    pending: "Pending Requests", "all-trips": "All Trips", drivers: "Drivers",
    vehicles: "Fleet", users: "Users", "my-assignments": "My Assignments", "db-setup": "DB Setup",
  };

  if (!user) return <AuthScreen onLogin={setUser} />;

  const renderPage = () => {
    switch (page) {
      case "dashboard": return <DashboardPage user={user} trips={trips} drivers={drivers} vehicles={vehicles} />;
      case "new-request": return <NewRequestPage user={user} onSubmit={async (t) => addTrip(t)} />;
      case "my-trips": return <MyTripsPage user={user} trips={trips} onCancel={handleCancel} onFeedback={handleFeedback} />;
      case "pending": return <PendingRequestsPage trips={trips} drivers={drivers} vehicles={vehicles} onApprove={handleApprove} onDecline={handleDecline} onAssign={handleAssign} />;
      case "all-trips": return <AllTripsPage trips={trips} drivers={drivers} vehicles={vehicles} onApprove={handleApprove} onDecline={handleDecline} onAssign={handleAssign} />;
      case "my-assignments": return <DriverAssignmentsPage user={user} trips={trips} drivers={drivers} vehicles={vehicles} onAccept={() => {}} onDecline={handleDriverDecline} onStart={handleStart} onEnd={handleEnd} />;
      case "drivers": return <DriversPage drivers={drivers} vehicles={vehicles} user={user} />;
      case "vehicles": return <VehiclesPage vehicles={vehicles} user={user} />;
      case "db-setup": return <DBSetupPage />;
      default: return <DashboardPage user={user} trips={trips} drivers={drivers} vehicles={vehicles} />;
    }
  };

  return (
    <>
      <style>{css}</style>
      <AppContext.Provider value={{ user, trips, drivers, vehicles }}>
        <div className="app-shell">
          <Sidebar
            user={user}
            activePage={page}
            onNavigate={handleNavigate}
            collapsed={!sidebarOpen}
            onToggle={() => setSidebarOpen(o => !o)}
          />

          <div className={`main-area ${!sidebarOpen ? "full" : ""}`}>
            <div className="topbar">
              <button className="menu-toggle" onClick={() => setSidebarOpen(o => !o)}>☰</button>
              <div className="page-title">{pageTitles[page] || "LSS 360"}</div>
              <div className="topbar-right">
                {pendingCount > 0 && (user.role === "journey_manager" || user.role === "admin") && (
                  <button className="btn btn-warning btn-sm" onClick={() => setPage("pending")} style={{ fontSize: 12 }}>
                    ⏳ {pendingCount} Pending
                  </button>
                )}
                <span className="role-badge">{roleLabel(user.role)}</span>
              </div>
            </div>

            <div className="page-content">
              {renderPage()}
            </div>
          </div>

          {/* Mobile sidebar overlay */}
          {sidebarOpen && window.innerWidth < 768 && (
            <div onClick={() => setSidebarOpen(false)}
              style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.5)", zIndex: 99 }} />
          )}
        </div>
      </AppContext.Provider>
    </>
  );
}
