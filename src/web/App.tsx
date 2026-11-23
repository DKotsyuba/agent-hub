/** Web-only Agent Hub shell, routing, preferences, and scoped stream ownership. */
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Activity, ArrowLeft, Bot, Gauge, GitBranch, Layers3, LayoutDashboard, RefreshCw, Settings, Download } from 'lucide-react';
import { version as webVersion } from '../../package.json';
import type { Topic } from '@agent-hub/domain';
import { Button } from '../components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Choice } from '../components/hub-primitives';
import { client, LiveContext, useLive, useRead } from './data';
import { Incidents, Overview, Period, Quota, WorktreeDetails } from './catalog';
import { PoolDetails, SessionDetails } from './details';
import { InventoryList, inventoryHref } from './lists';
import type { Inventory } from './lists';
import { Expand, href, Link, Navigation, relativeTime, useWebText } from './ui';
import { useAppUpdate } from './pwa';

/** Primary screens and their stable addresses. */
const navigation = [
  ['overview', '/', 'Overview', LayoutDashboard], ['sessions', '/sessions', 'Sessions', Bot],
  ['pools', '/pools', 'Pools', Layers3], ['quota', '/quota', 'Quota', Gauge],
  ['worktrees', '/worktrees', 'Worktree', GitBranch],
] as const;

/** URL is the sole source of screen, selection, tab and filter identity. */
function locationView() {
  const [, base, selected, suffix] = location.pathname.split('/');
  const kind: typeof navigation[number][0] | 'incidents' = navigation.find(item => item[0] === base)?.[0] ?? (base === 'incidents' ? 'incidents' : 'overview');
  const inventory = kind === 'sessions' || kind === 'pools' || kind === 'worktrees' ? kind : null;
  const id = inventory && selected && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(selected) ? selected : null;
  const options = kind === 'sessions' ? ['history', 'result', 'details'] : ['discussion', 'members', 'details', 'proposals', 'decisions', 'criteria', 'votes', 'deliveries', 'record'];
  return { kind, inventory, id, tab: options.includes(suffix) ? suffix : options[0], query: new URLSearchParams(location.search) };
}

/** Per-entry scroll and focus snapshot, written only at route boundaries. */
type Snapshot = { key: string; from: string | null; focus?: string; scroll?: number; list?: number; detail?: number };

/** Persisted appearance defaults to the document's system preference. */
function savedTheme() {
  try {
    const value = localStorage.getItem('agent-hub-theme');
    return value === 'light' || value === 'dark' ? value : 'system';
  }
  catch { return 'system'; }
}

/** Picks only the inventory and visible detail topics, plus its metadata dependencies. */
function topicsFor(kind: ReturnType<typeof locationView>['kind'], id: string | null, tab: string): Topic[] {
  if (!id) return [kind];
  if (kind === 'sessions') return [kind, `session:${id}:detail`,
    ...(tab !== 'result' ? [`session:${id}:initial-task` as Topic] : []),
    ...(tab !== 'details' ? [`session:${id}:${tab}` as Topic] : [])];
  if (kind === 'pools') return [...new Set<Topic>([kind, `pool:${id}:detail`, `pool:${id}:members`,
    `pool:${id}:${({ discussion: 'history', details: 'content', record: 'records' } as Record<string, string>)[tab] ?? tab}` as Topic,
    ...(tab === 'proposals' ? [`pool:${id}:content` as Topic] : [])])];
  return ['worktrees', `worktree:${id}:detail`];
}

/** Renders the same selected URL in a desktop split or phone full-screen detail. */
export default function App() {
  const { label, locale, setLocale, tag, clock } = useWebText();
  const [address, setAddress] = useState(() => location.pathname + location.search);
  const [theme, setTheme] = useState(savedTheme);
  const [interval, setInterval] = useState<1 | 3 | 5 | 10>(3);
  const [refresh, setRefresh] = useState(0);
  const [settings, setSettings] = useState(false);
  const [now, setNow] = useState(Date.now);
  const [lastRead, reportRead] = useState<number>();
  const appUpdate = useAppUpdate();
  const route = locationView();
  const { id, kind, query, tab, inventory } = route;
  const live = useLive(topicsFor(kind, id, tab), interval);
  const health = useRead('health:' + refresh + ':' + (live.connection === 'connected'), signal => client.get('health', { signal }), undefined, 30_000);
  const [serverRelease, setServerRelease] = useState<string>();
  useEffect(() => {
    if (health.value) setServerRelease(health.value.release);
  }, [health.value]);
  const updateAvailable = appUpdate.waiting || (!!serverRelease && serverRelease !== webVersion);
  const unreachable = health.error === 'network_unavailable' && live.connection !== 'connected';
  const connection = unreachable ? 'Server unreachable' : live.connection;
  const heading = useRef<HTMLHeadingElement>(null);
  const list = useRef<HTMLElement>(null);
  const detail = useRef<HTMLElement>(null);
  const restore = useRef<Snapshot | null>(null);
  const fallbackFocus = useRef(false);
  const current = useRef<Snapshot>(history.state?.hub ?? { key: crypto.randomUUID(), from: null });
  const saved = useRef(new Map<string, Snapshot>());
  const parent = inventory ? inventoryHref(inventory, query) : href('/', { from: query.get('from'), to: query.get('to') });

  /** Saves the outgoing viewport using the current rendered document. */
  function capture() {
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey : undefined;
    saved.current.set(current.current.key, { ...current.current, focus, scroll: window.scrollY, list: list.current?.scrollTop, detail: detail.current?.scrollTop });
  }

  /** Navigates once, preserving modifier-click behavior in Link. */
  function go(target: string, replace = false, focus = true) {
    if (target === location.pathname + location.search) return;
    if (!replace) capture();
    const entry = replace ? current.current : { key: crypto.randomUUID(), from: address };
    history[replace ? 'replaceState' : 'pushState']({ hub: entry }, '', target);
    current.current = entry;
    fallbackFocus.current = focus;
    setAddress(target);
  }

  /** Returns through the actual origin entry or through the standalone parent URL. */
  function back() {
    if (current.current.from) history.back();
    else go(parent, true);
  }

  /** Filter changes are shareable and invalidate the old pagination boundary. */
  function update(values: Record<string, string | null>, keepCursor = false) {
    const next = new URLSearchParams(query);
    if (!keepCursor) next.delete('cursor');
    for (const [key, value] of Object.entries(values)) {
      if (value) next.set(key, value);
      else next.delete(key);
    }
    go(location.pathname + (next.size ? '?' + next : ''), true, false);
  }

  /** Keeps primary tabs prominent and retains directly addressable secondary tabs. */
  function tabs(items: string[], content: ReactNode, extra: string[] = []) {
    const target = (value: string) => '/' + kind + '/' + id + '/' + value + location.search;
    const selectTab = (value: string) => go(target(value), true, false);
    const tabLink = (value: string, current = false) => <Link href={target(value)} aria-current={current ? 'page' : undefined} onClick={event => {
      if (!(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) { event.preventDefault(); selectTab(value); }
    }}>{label(value)}</Link>;
    const visible = extra.includes(tab) ? [...items, tab] : items;
    return <Tabs value={tab} onValueChange={selectTab}>
      <TabsList className="web-tabs" aria-label={label('Detail sections')}>
        {visible.map(item => <TabsTrigger key={item} value={item} asChild>{tabLink(item)}</TabsTrigger>)}
      </TabsList>
      <TabsContent value={tab}>{content}</TabsContent>
      {!!extra.length && <Expand title="More sections"><div className="web-more-links">{extra.map(item =>
        <span className="web-link" key={item}>{tabLink(item, item === tab)}</span>)}</div></Expand>}
    </Tabs>;
  }

  useEffect(() => {
    const tick = () => { if (!document.hidden) setNow(Date.now()); };
    const timer = window.setInterval(tick, 15_000);
    document.addEventListener('visibilitychange', tick);
    return () => {
      window.clearInterval(timer);
      document.removeEventListener('visibilitychange', tick);
    };
  }, []);

  useEffect(() => {
    history.scrollRestoration = 'manual';
    history.replaceState({ hub: current.current }, '');
    const pop = () => {
      capture();
      current.current = history.state?.hub ?? { key: crypto.randomUUID(), from: null };
      restore.current = saved.current.get(current.current.key) ?? null;
      fallbackFocus.current = !restore.current;
      setAddress(location.pathname + location.search);
    };
    window.addEventListener('popstate', pop);
    return () => window.removeEventListener('popstate', pop);
  }, []);

  useLayoutEffect(() => {
    const snapshot = restore.current;
    const focus = fallbackFocus.current;
    if (!snapshot && !focus) return;
    restore.current = null;
    fallbackFocus.current = false;
    const apply = () => {
      const target = snapshot?.focus && Array.from(document.querySelectorAll<HTMLElement>('[data-focus-key]')).find(item => item.dataset.focusKey === snapshot.focus && item.getClientRects().length);
      if (snapshot?.focus && !target) return false;
      (target || heading.current)?.focus({ preventScroll: true });
      window.scrollTo(0, snapshot?.scroll ?? 0);
      if (list.current) list.current.scrollTop = snapshot?.list ?? 0;
      if (detail.current) detail.current.scrollTop = snapshot?.detail ?? 0;
      return true;
    };
    if (apply()) return;
    const observer = new MutationObserver(() => {
      if (apply()) { observer.disconnect(); window.clearTimeout(timeout); }
    });
    observer.observe(document.querySelector('main')!, { childList: true, subtree: true });
    const timeout = window.setTimeout(() => { observer.disconnect(); heading.current?.focus(); }, 2000);
    return () => { observer.disconnect(); window.clearTimeout(timeout); };
  }, [address]);

  useEffect(() => {
    const media = matchMedia('(prefers-color-scheme: dark)');
    const apply = () => {
      const dark = theme === 'dark' || (theme === 'system' && media.matches);
      document.documentElement.classList.toggle('dark', dark);
      for (const meta of document.querySelectorAll('meta[name=theme-color]')) meta.setAttribute('content', dark ? '#141c29' : '#f7f8fa');
      const manifest = document.querySelector('link[rel=manifest]');
      manifest?.setAttribute('href', dark ? '/manifest-dark.webmanifest' : '/manifest.webmanifest');
    };
    apply();
    media.addEventListener('change', apply);
    try { localStorage.setItem('agent-hub-theme', theme); } catch { /* Preference remains available in memory. */ }
    return () => media.removeEventListener('change', apply);
  }, [theme]);

  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey || settings
          || (event.target instanceof HTMLElement && event.target.closest('input,select,textarea,[contenteditable=true],[role=combobox]'))) return;
      const destination = /^[0-4]$/.test(event.key) ? navigation[+event.key] : undefined;
      if (destination) go(destination[1]);
      if (event.key === 'r') setRefresh(value => value + 1);
      if (event.key === '?') setSettings(true);
      if (event.key === '/' && inventory) {
        const search = list.current?.querySelector<HTMLInputElement>('input[type=search]');
        if (search?.getClientRects().length) { event.preventDefault(); search.focus(); }
      }
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [address, inventory, settings]);

  const title = kind === 'incidents' ? 'Bridge incidents' : navigation.find(item => item[0] === kind)![2];
  const header = <div className={id ? 'web-heading web-heading-detail' : 'web-heading'}>
    <div className="web-heading-title">
      {(id || kind === 'incidents') && <Link href={parent} data-focus-key="back" className="web-back web-link" onClick={event => {
        if (!(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) { event.preventDefault(); back(); }
      }}><ArrowLeft size={16} />{label('Back')}</Link>}
      <h1 ref={heading} tabIndex={-1}>{id ? label(kind === 'sessions' ? 'Session detail' : kind === 'pools' ? 'Pool detail' : 'Worktree detail') : label(title)}</h1>
      {health.value?.mode === 'fixture' && <span className="web-fixture">{label('Fixture data')}</span>}
    </div>
    <div className="web-controls web-header-controls">
      {updateAvailable && <Button className="web-update" size="sm" disabled={appUpdate.updating} onClick={() => void appUpdate.activate()}>
        <Download size={14} aria-hidden="true" />{label(appUpdate.updating ? 'Updating app' : 'Update app')}
      </Button>}
      <span className="web-connection"><span className={live.connection === 'connected' ? 'online' : ''} />{label(connection)}</span>
      <Button variant="outline" size="icon" onClick={() => setRefresh(value => value + 1)} aria-label={label('Refresh data')}><RefreshCw size={16} /></Button>
    </div>
  </div>;

  return <Navigation.Provider value={go}><LiveContext.Provider value={{ ...live, refresh, unreachable, reportRead }}>
    <div className="web-shell">
      <a className="skip-link" href="#web-main">{label('Skip to content')}</a>
      <aside className="web-rail">
        <Link className="web-brand" href="/" data-focus-key="brand"><span><Activity size={20} /></span><strong>Agent Hub</strong></Link>
        <nav aria-label={label('Navigation')}>
          {navigation.map(([key, path, name, Icon]) => <Link href={path} key={key} data-focus-key={key}
            aria-current={key === kind || (key === 'overview' && kind === 'incidents') ? 'page' : undefined}>
            <Icon size={18} aria-hidden="true" />{label(name)}
          </Link>)}
        </nav>
        <div className="web-preferences">
          <Dialog open={settings} onOpenChange={setSettings}>
            <DialogTrigger asChild><Button className="web-settings-trigger" variant="ghost" aria-label={label('Settings')}>
              <Settings size={18} aria-hidden="true" /><span>{label('Settings')}</span>
            </Button></DialogTrigger>
            <DialogContent className="settings-dialog">
              <DialogTitle>{label('Settings')}</DialogTitle>
              <DialogDescription>{label('Keyboard shortcuts')} · {label('0–4 Switch screen · R Refresh · / Search · ? Help')}</DialogDescription>
              <div className="web-settings-fields">
                <span>{label('Appearance')}</span>
                <Choice label={label('Appearance')} value={theme} options={['system', 'light', 'dark'].map(value => [value, label(value)])} onChange={setTheme} />
                <span>{label('Language')}</span>
                <Choice label={label('Language')} value={locale} options={[[ 'en', 'English'], ['ru', 'Русский']]} onChange={value => setLocale(value === 'ru' ? 'ru' : 'en')} />
                <span>{label('Refresh cadence')}</span>
                <Choice label={label('Refresh cadence')} value={String(interval)} options={[1, 3, 5, 10].map(value => [String(value), value + ' ' + label('sec')])} onChange={value => setInterval(Number(value) as 1 | 3 | 5 | 10)} />
              </div>
              <div><DialogClose asChild><Button>{label('Done')}</Button></DialogClose></div>
            </DialogContent>
          </Dialog>
        </div>
      </aside>
      <main id="web-main" className="web-main" tabIndex={-1}>
        {header}
        {unreachable && <p className="web-warning web-offline" role="status">{label('Offline shell')}</p>}
        {appUpdate.error && <p className="web-warning" role="status">{label('Update failed')}</p>}
        <div className="web-page">
        {inventory ? <div className={'web-split' + (id ? ' web-has-detail' : '')}>
          <section ref={list} className="web-list-pane" aria-label={label(title)}>
            <InventoryList key={inventory} kind={inventory as Inventory} query={query} id={id} update={update} />
          </section>
          {id && <section ref={detail} className="web-detail-pane" aria-label={label('Details')} key={kind + ':' + id + ':' + query.get('execution')}>
            {inventory === 'sessions' ? <SessionDetails id={id} execution={query.get('execution')} tab={tab} tabs={tabs} />
              : inventory === 'pools' ? <PoolDetails id={id} tab={tab} tabs={tabs} proposal={query.get('proposal')} select={proposal => update({ proposal }, true)} />
              : <WorktreeDetails id={id} />}
          </section>}
        </div> : <>
          {kind === 'incidents' && <Period query={query} update={update} />}
          {kind === 'overview' ? <Overview query={query}
            filter={<div className="web-overview-period"><Expand title={label('Period filter') + (query.has('from') || query.has('to') ? ' · ' + label('Filtered') : '')}>
              <Period query={query} update={update} />
            </Expand></div>} /> : kind === 'incidents'
            ? <Incidents query={query} next={cursor => update({ cursor }, true)} /> : <Quota now={Math.max(now, lastRead ?? 0)} />}
        </>}
        </div>
        <footer className="web-footer">
          <span>Hub {webVersion}</span>
          <span>{label('Server version')} {serverRelease ?? '—'}</span>
          <span>{label(connection)}</span>
          <span title={lastRead ? clock(lastRead) : undefined}>{label('Updated')} {lastRead ?
            relativeTime(lastRead, Math.max(now, lastRead), tag) : '—'}</span>
        </footer>
      </main>
    </div>
  </LiveContext.Provider></Navigation.Provider>;
}
