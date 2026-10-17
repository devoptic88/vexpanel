import { useEffect, useState, type ReactNode } from 'react';
import {
  Activity, Boxes, Clock, LayoutGrid, Database, FolderOpen, Globe, Home, KeyRound, LayoutDashboard, ListChecks, LogOut, Mail, Menu, Network, ShieldCheck, Users,
} from 'lucide-react';
import { get, post, type Me } from './api';
import { Link, Loading, navigate, usePath } from './components/ui';
import Login from './pages/Login';
import AdminDashboard from './pages/admin/Dashboard';
import Accounts from './pages/admin/Accounts';
import Packages from './pages/admin/Packages';
import Audit from './pages/admin/Audit';
import UserHome from './pages/user/Home';
import Domains from './pages/user/Domains';
import Files from './pages/user/Files';
import Databases from './pages/user/Databases';
import Email from './pages/user/Email';
import Dns from './pages/user/Dns';
import Ssl from './pages/user/Ssl';
import Cron from './pages/user/Cron';
import Apps from './pages/user/Apps';
import Password from './pages/Password';

interface NavItem { to: string; label: string; icon: ReactNode }

const ADMIN_NAV: Array<{ group?: string; items: NavItem[] }> = [
  { items: [{ to: '/admin', label: 'Server', icon: <LayoutDashboard /> }] },
  {
    group: 'Hosting',
    items: [
      { to: '/admin/accounts', label: 'Accounts', icon: <Users /> },
      { to: '/admin/packages', label: 'Packages', icon: <Boxes /> },
    ],
  },
  {
    group: 'Security',
    items: [
      { to: '/admin/audit', label: 'Activity log', icon: <ListChecks /> },
      { to: '/password', label: 'Your password', icon: <KeyRound /> },
    ],
  },
];

const USER_NAV: Array<{ group?: string; items: NavItem[] }> = [
  { items: [{ to: '/', label: 'Home', icon: <Home /> }] },
  {
    group: 'Websites',
    items: [
      { to: '/apps', label: 'Apps', icon: <LayoutGrid /> },
      { to: '/domains', label: 'Domains', icon: <Globe /> },
      { to: '/files', label: 'File manager', icon: <FolderOpen /> },
      { to: '/ssl', label: 'SSL certificates', icon: <ShieldCheck /> },
      { to: '/dns', label: 'DNS zones', icon: <Network /> },
    ],
  },
  {
    group: 'Data & mail',
    items: [
      { to: '/databases', label: 'Databases', icon: <Database /> },
      { to: '/email', label: 'Email', icon: <Mail /> },
    ],
  },
  {
    group: 'Advanced',
    items: [
      { to: '/cron', label: 'Cron jobs', icon: <Clock /> },
      { to: '/password', label: 'Password', icon: <KeyRound /> },
    ],
  },
];

export default function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [version, setVersion] = useState('');
  const path = usePath();

  const refresh = async () => setMe(await get<Me>('/api/auth/me'));

  useEffect(() => {
    void refresh();
    void get<{ dryRun: boolean; version: string }>('/api/health').then((h) => {
      setDryRun(h.dryRun);
      setVersion(h.version);
    });
    const out = () => setMe({ user: null });
    window.addEventListener('vex:signed-out', out);
    return () => window.removeEventListener('vex:signed-out', out);
  }, []);

  if (!me) return <Loading />;
  if (!me.user) return <Login onSignedIn={refresh} />;

  const isAdmin = me.user.role === 'admin';
  // Keep each role on its own side of the panel.
  if (isAdmin && !path.startsWith('/admin') && path !== '/password') {
    queueMicrotask(() => navigate('/admin'));
    return null;
  }
  if (!isAdmin && path.startsWith('/admin')) {
    queueMicrotask(() => navigate('/'));
    return null;
  }

  return (
    <Shell me={me} nav={isAdmin ? ADMIN_NAV : USER_NAV} path={path} dryRun={dryRun} version={version} onChange={refresh}>
      <Route path={path} admin={isAdmin} />
    </Shell>
  );
}

function Route({ path, admin }: { path: string; admin: boolean }) {
  if (path === '/password') return <Password />;
  if (admin) {
    switch (path) {
      case '/admin/accounts': return <Accounts />;
      case '/admin/packages': return <Packages />;
      case '/admin/audit': return <Audit />;
      default: return <AdminDashboard />;
    }
  }
  switch (path) {
    case '/domains': return <Domains />;
    case '/files': return <Files />;
    case '/databases': return <Databases />;
    case '/email': return <Email />;
    case '/dns': return <Dns />;
    case '/ssl': return <Ssl />;
    case '/cron': return <Cron />;
    case '/apps': return <Apps />;
    default: return <UserHome />;
  }
}

function Shell({
  me, nav, path, children, dryRun, version, onChange,
}: { me: Me; nav: typeof USER_NAV; path: string; children: ReactNode; dryRun: boolean; version: string; onChange: () => Promise<void> }) {
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(false), [path]);
  const user = me.user!;

  return (
    <>
      <div className="shell">
        <aside className={`side${open ? ' open' : ''}`}>
          <div className="brand">
            <div className="brand-mark" aria-hidden><span /><span /><span /></div>
            <div>VEXPANEL<br /><small>{user.role === 'admin' ? 'Server administration' : user.username}</small></div>
          </div>
          <nav className="nav" aria-label="Main">
            {nav.map((g, i) => (
              <div key={i}>
                {g.group && <div className="nav-group">{g.group}</div>}
                {g.items.map((it) => (
                  <Link key={it.to} to={it.to} current={path === it.to}>
                    {it.icon}
                    {it.label}
                  </Link>
                ))}
              </div>
            ))}
          </nav>
          <div className="side-foot">
            <span><Activity size={13} style={{ verticalAlign: '-2px' }} /> Version {version}</span>
            <button
              className="small"
              onClick={async () => {
                await post('/api/auth/logout');
                history.replaceState(null, '', '/');
                await onChange();
              }}
            >
              <LogOut /> Sign out
            </button>
          </div>
        </aside>
        <main className="main">
          <button className="menu-btn small" onClick={() => setOpen(true)} aria-label="Open menu">
            <Menu /> Menu
          </button>
          {me.impersonatedBy && (
            <div className="banner">
              <span>You're signed in as {user.username} from the admin account {me.impersonatedBy}.</span>
              <button className="small" onClick={async () => { await post('/api/auth/return'); navigate('/admin/accounts'); await onChange(); }}>
                Return to admin
              </button>
            </div>
          )}
          {dryRun && (
            <div className="banner dry">
              <span>Dry-run mode: nothing on this machine changes. Generated configs are written under the data folder.</span>
            </div>
          )}
          {children}
        </main>
      </div>
    </>
  );
}
