import { readFileSync } from 'node:fs';
import { config } from '../config.js';

/**
 * Where an app's package comes from. Resolved on the server at install time, so
 * "latest" links stay current without a panel update.
 */
export type AppSource =
  | { type: 'url'; url: string }
  /** Latest GitHub release asset whose file name matches `asset`. */
  | { type: 'github'; repo: string; asset: string }
  /** phpBB's own version feed for a release branch, then the official download server. */
  | { type: 'phpbb'; branch: string; fallback: string }
  /** An archive the account uploaded itself (vBulletin, XenForo and other paid software). */
  | { type: 'upload' };

export type Setup =
  /** The panel finishes the install: no setup wizard to click through. */
  | 'auto'
  /** Files and a database are prepared; the app's own wizard (at `setupPath`) finishes it. */
  | 'wizard';

export interface AppDef {
  id: string;
  name: string;
  category: 'Forums' | 'Blogs & CMS' | 'Wikis' | 'Tools' | 'Your own software';
  description: string;
  source: AppSource;
  /** Directory inside the archive that holds the app. `*` matches anything; omitted = auto-detect. */
  subdir?: string;
  database: boolean;
  setup: Setup;
  /** Page that finishes setup, relative to the app's URL (wizard apps). */
  setupPath?: string;
  /** Page an admin signs in at, relative to the app's URL. */
  adminPath?: string;
  /** Default folder under the web root, '' for the root itself. */
  defaultFolder: string;
  /** Needs admin username/password/email in the install form. */
  needsAdmin?: boolean;
  homepage: string;
}

export const CATALOG: AppDef[] = [
  {
    id: 'phpbb',
    name: 'phpBB',
    category: 'Forums',
    description: 'Classic, widely used open-source forum software.',
    source: { type: 'phpbb', branch: '3.3', fallback: '3.3.19' },
    subdir: 'phpBB3',
    database: true,
    setup: 'auto',
    adminPath: 'adm/',
    defaultFolder: 'forum',
    needsAdmin: true,
    homepage: 'https://www.phpbb.com/',
  },
  {
    id: 'mybb',
    name: 'MyBB',
    category: 'Forums',
    description: 'Free forum software with a large plugin and theme library.',
    source: { type: 'github', repo: 'mybb/mybb', asset: '^mybb_\\d+\\.zip$' },
    subdir: 'Upload',
    database: true,
    setup: 'wizard',
    setupPath: 'install/',
    adminPath: 'admin/',
    defaultFolder: 'forum',
    homepage: 'https://mybb.com/',
  },
  {
    id: 'smf',
    name: 'Simple Machines Forum',
    category: 'Forums',
    description: 'Lightweight, mature forum software (SMF 2.1).',
    source: { type: 'github', repo: 'SimpleMachines/SMF', asset: 'install.*\\.(zip|tar\\.gz)$' },
    database: true,
    setup: 'wizard',
    setupPath: 'install.php',
    defaultFolder: 'forum',
    homepage: 'https://www.simplemachines.org/',
  },
  {
    id: 'custom',
    name: 'Upload your own',
    category: 'Your own software',
    description: 'vBulletin, XenForo, Invision Community or any PHP app you have a licensed copy of. Upload its .zip or .tar.gz in the file manager first.',
    source: { type: 'upload' },
    database: true,
    setup: 'wizard',
    defaultFolder: 'forum',
    homepage: '',
  },
  {
    id: 'wordpress',
    name: 'WordPress',
    category: 'Blogs & CMS',
    description: 'The most popular website and blog platform.',
    source: { type: 'url', url: 'https://wordpress.org/latest.tar.gz' },
    subdir: 'wordpress',
    database: true,
    setup: 'auto',
    adminPath: 'wp-admin/',
    defaultFolder: '',
    needsAdmin: true,
    homepage: 'https://wordpress.org/',
  },
  {
    id: 'joomla',
    name: 'Joomla',
    category: 'Blogs & CMS',
    description: 'Flexible content management system for larger sites.',
    source: { type: 'url', url: 'https://downloads.joomla.org/cms/joomla6/6-2-0/Joomla_6-2-0-Stable-Full_Package.zip?format=zip' },
    database: true,
    setup: 'wizard',
    setupPath: 'installation/index.php',
    adminPath: 'administrator/',
    defaultFolder: 'cms',
    homepage: 'https://www.joomla.org/',
  },
  {
    id: 'drupal',
    name: 'Drupal',
    category: 'Blogs & CMS',
    description: 'Powerful CMS for structured, content-heavy sites.',
    source: { type: 'url', url: 'https://www.drupal.org/download-latest/tar.gz' },
    subdir: 'drupal-*',
    database: true,
    setup: 'wizard',
    setupPath: 'core/install.php',
    defaultFolder: 'drupal',
    homepage: 'https://www.drupal.org/',
  },
  {
    id: 'dokuwiki',
    name: 'DokuWiki',
    category: 'Wikis',
    description: 'Simple wiki that stores pages as files, no database needed.',
    source: { type: 'url', url: 'https://download.dokuwiki.org/src/dokuwiki/dokuwiki-stable.tgz' },
    subdir: 'dokuwiki*',
    database: false,
    setup: 'wizard',
    setupPath: 'install.php',
    defaultFolder: 'wiki',
    homepage: 'https://www.dokuwiki.org/',
  },
  {
    id: 'matomo',
    name: 'Matomo',
    category: 'Tools',
    description: 'Privacy-friendly web analytics you host yourself.',
    source: { type: 'url', url: 'https://builds.matomo.org/matomo-latest.zip' },
    subdir: 'matomo',
    database: true,
    setup: 'wizard',
    setupPath: '',
    defaultFolder: 'analytics',
    homepage: 'https://matomo.org/',
  },
  {
    id: 'phpmyadmin',
    name: 'phpMyAdmin',
    category: 'Tools',
    description: 'Manage your databases in the browser. Sign in with a database user from the Databases page.',
    source: { type: 'url', url: 'https://www.phpmyadmin.net/downloads/phpMyAdmin-latest-all-languages.tar.gz' },
    subdir: 'phpMyAdmin-*',
    database: false,
    setup: 'auto',
    defaultFolder: 'phpmyadmin',
    homepage: 'https://www.phpmyadmin.net/',
  },
];

/**
 * Admins can override any field (for example to pin a version or use a mirror) in
 * /etc/vexpanel/apps.json: { "joomla": { "source": { "type": "url", "url": "…" } } }.
 */
function loadOverrides(): Record<string, Partial<AppDef>> {
  const file = process.env.VEX_APPS_FILE ?? '/etc/vexpanel/apps.json';
  try {
    return JSON.parse(readFileSync(file, 'utf8')) as Record<string, Partial<AppDef>>;
  } catch {
    return {};
  }
}

export function catalog(): AppDef[] {
  const o = loadOverrides();
  return CATALOG.map((a) => ({ ...a, ...(o[a.id] ?? {}), id: a.id }));
}

export function findApp(id: string): AppDef | undefined {
  return catalog().find((a) => a.id === id);
}

/** Resolve the package URL for an app. Runs on the server, which can reach the download sites. */
export async function resolveDownload(app: AppDef): Promise<{ url: string; version: string }> {
  const src = app.source;
  const ua = { 'user-agent': `VEXPANEL/${config.version}` };
  switch (src.type) {
    case 'url':
      return { url: src.url, version: 'latest' };
    case 'github': {
      const r = await fetch(`https://api.github.com/repos/${src.repo}/releases/latest`, { headers: { ...ua, accept: 'application/vnd.github+json' } });
      if (!r.ok) throw new Error(`Couldn't look up the latest ${app.name} release (GitHub answered ${r.status}).`);
      const rel = (await r.json()) as { tag_name: string; assets: Array<{ name: string; browser_download_url: string }> };
      const re = new RegExp(src.asset, 'i');
      const asset = rel.assets.find((a) => re.test(a.name));
      if (!asset) throw new Error(`The latest ${app.name} release (${rel.tag_name}) has no installable package.`);
      // Tags look like v2.1.8 or mybb_1841; keep the numeric part.
      return { url: asset.browser_download_url, version: rel.tag_name.replace(/^[^\d]*/, '') || rel.tag_name };
    }
    case 'phpbb': {
      let version = src.fallback;
      try {
        const r = await fetch('https://version.phpbb.com/phpbb/versions.json', { headers: ua, signal: AbortSignal.timeout(10_000) });
        if (r.ok) {
          const feed = (await r.json()) as { stable?: Record<string, { current?: string }> };
          const v = feed.stable?.[src.branch]?.current;
          if (v && /^\d+\.\d+\.\d+$/.test(v)) version = v;
        }
      } catch {
        /* use the pinned fallback */
      }
      return { url: `https://download.phpbb.com/pub/release/${src.branch}/${version}/phpBB-${version}.zip`, version };
    }
    case 'upload':
      throw new Error('Uploaded packages have no download URL.');
  }
}
