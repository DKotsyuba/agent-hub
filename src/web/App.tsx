/** Web-only Agent Hub shell, routing, preferences, and scoped stream ownership. */
import type { ReactNode } from 'react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useViewportInsets } from './viewport';
import { Activity, ArrowLeft, Bot, Gauge, GitBranch, Layers3, LayoutDashboard, RefreshCw, Settings, Download, PanelLeft, List, Copy, Check } from 'lucide-react';
import { version as webVersion } from '../../package.json';
import type { Topic } from '@agent-hub/domain';
import { Button } from '../components/ui/button';
import { Dialog, DialogClose, DialogContent, DialogDescription, DialogTitle, DialogTrigger } from '../components/ui/dialog';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '../components/ui/tabs';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '../components/ui/tooltip';
import { Choice } from '../components/hub-primitives';
import { client, LiveContext, useLive, useRead } from './data';
import { Incidents, Overview, Period, Quota, WorktreeDetails } from './catalog';
import { PoolDetails, SessionDetails, type DetailHeading } from './details';
import { InventoryList, inventoryHref } from './lists';
import type { Inventory } from './lists';
import { Expand, href, Link, Navigation, relativeTime, useWebText } from './ui';
import { useAppUpdate } from './pwa';
import { HeldAlert, HeldContext } from './held';
import { heldState } from '../../packages/view-model/src/index';

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

/** A stored override takes precedence over the desktop or tablet width default. */
function savedSidebar() {
  try {
    const stored = localStorage.getItem('agent-hub-sidebar');
    return stored === 'expanded' ? true : stored === 'collapsed' ? false : null;
  } catch { return null; }
}

/** Adds a label to icon controls without placing it inside the rail. */
function RailHint({ label, children }: { label: string; children: React.ReactElement }) {
  return <Tooltip><TooltipTrigger asChild>{children}</TooltipTrigger>
    <TooltipContent side="right" className="web-rail-hint">{label}</TooltipContent>
  </Tooltip>;
}

/** Copies the route identifier with immediate, localized clipboard feedback. */
function CopyId({ id }: { id: string }) {
  const { label } = useWebText();
  const [notice, setNotice] = useState('');
  return <div className="web-identity">
    <code title={id}>{id}</code>
    <Button variant="ghost" size="icon" title={label('Copy ID')} aria-label={label('Copy ID')} onClick={async () => {
      try { await navigator.clipboard.writeText(id); setNotice('Copied'); }
      catch { setNotice('Copy failed'); }
    }}>{notice === 'Copied' ? <Check size={13} /> : <Copy size={13} />}</Button>
    <span className={notice === 'Copy failed' ? 'web-caution' : 'sr-only'} role="status">{notice && label(notice)}</span>
  </div>;
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
  const [sidebar, setSidebar] = useState(savedSidebar);
  const [wide, setWide] = useState(() => matchMedia('(min-width: 1280px)').matches);
  const [listVisible, setListVisible] = useState(true);
  const expanded = sidebar ?? wide;
  useEffect(() => {
    const media = matchMedia('(min-width: 1280px)');
    const resize = () => setWide(media.matches);
    media.addEventListener('change', resize);
    resize();
    return () => media.removeEventListener('change', resize);
  }, []);
  const [interval, setInterval] = useState<1 | 3 | 5 | 10>(3);
  const [refresh, setRefresh] = useState(0);
  const [settings, setSettings] = useState(false);
  const viewport = useViewportInsets();
  const [now, setNow] = useState(Date.now);
  const [lastRead, reportRead] = useState<number>();
  const appUpdate = useAppUpdate();
  const route = locationView();
  const { id, kind, query, tab, inventory } = route;
  const immersive = !!id && (kind === 'sessions' || kind === 'pools');
  const showHistory = immersive && (tab === 'history' || tab === 'discussion');
  const live = useLive(topicsFor(kind, id, tab), interval);
  const health = useRead('health:' + refresh + ':' + (live.connection === 'connected'), signal => client.get('health', { signal }), undefined, 30_000);
  // Polled independently of the screen topic so the alarm shows on every page; a failed read keeps the last value.
  const heldRead = useRead('held:' + refresh, signal => client.get('held', { signal }), undefined, 20_000);
  const heldSummary = useMemo(() => {
    const read = heldRead.value;
    if (!read) return { alarm: null, stale: 0 };
    const { pending, oldestScannedAtMs, items, complete } = read.data;
    return heldState(items, Math.max(now, read.observations[0]?.observedAtMs ?? 0), complete, undefined, { pending, oldestScannedAtMs });
  }, [heldRead.value, now]);
  const alarm = heldSummary.alarm;
  const [serverRelease, setServerRelease] = useState<string>();
  useEffect(() => {
    if (health.value) setServerRelease(health.value.release);
  }, [health.value]);
  const updateAvailable = appUpdate.waiting || (!!serverRelease && serverRelease !== webVersion);
  const unreachable = health.error === 'network_unavailable' && live.connection !== 'connected';
  const connection = unreachable ? 'Server unreachable' : live.connection;
  const heading = useRef<HTMLHeadingElement>(null);
  const page = useRef<HTMLDivElement>(null);
  const list = useRef<HTMLElement>(null);
  const detail = useRef<HTMLElement>(null);
  const restore = useRef<Snapshot | null>(null);
  const fallbackFocus = useRef(false);
  const current = useRef<Snapshot>(history.state?.hub ?? { key: crypto.randomUUID(), from: null });
  const saved = useRef(new Map<string, Snapshot>());
  const parent = inventory ? inventoryHref(inventory, query) : href('/', { from: query.get('from'), to: query.get('to') });

  /** Only one element owns the currently visible detail scroll position. */
  function detailViewport() {
    return detail.current?.querySelector<HTMLElement>('.web-transcript, .web-detail-scroll') ?? detail.current;
  }

  /** Saves the outgoing viewport using the current rendered document. */
  function capture() {
    const focus = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>('[data-focus-key]')?.dataset.focusKey : undefined;
    saved.current.set(current.current.key, { ...current.current, focus, scroll: page.current?.scrollTop, list: list.current?.scrollTop, detail: detailViewport()?.scrollTop });
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
    return <Tabs value={tab} onValueChange={selectTab} className="web-detail-tabs" activationMode="manual">
      <div className="web-detail-nav">
        <TabsList className="web-tabs" aria-label={label('Detail sections')}>
          {visible.map(item => <TabsTrigger key={item} value={item} asChild>{tabLink(item)}</TabsTrigger>)}
        </TabsList>
        {!!extra.length && <Choice label={label('More sections')} value="sections"
          options={[['sections', label('More')], ...extra.map(item => [item, label(item)] as [string, string])]}
          onChange={value => { if (value !== 'sections') selectTab(value); }} />}
      </div>
      <TabsContent className={showHistory ? 'web-history-tab' : 'web-detail-scroll'} value={tab}>{content}</TabsContent>
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
      if (page.current) page.current.scrollTop = snapshot?.scroll ?? 0;
      if (list.current) list.current.scrollTop = snapshot?.list ?? 0;
      const area = detailViewport();
      if (area) area.scrollTop = snapshot?.detail ?? 0;
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
          || (event.target instanceof HTMLElement && event.target.closest('input,select,textarea,[contenteditable=true],[role=combobox],[role=dialog]'))) return;
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
  const fallbackTitle = label(kind === 'sessions' ? 'Session detail' : kind === 'pools' ? 'Pool detail' : 'Worktree detail');
  const backLink = (id || kind === 'incidents') && <Link href={parent} data-focus-key="back" className="web-back web-link" onClick={event => {
    if (!(event.metaKey || event.ctrlKey || event.altKey || event.shiftKey)) { event.preventDefault(); back(); }
  }} aria-label={label('Back')} title={label('Back')}><ArrowLeft size={18} aria-hidden="true" /><span>{label('Back')}</span></Link>;
  const sidebarToggle = <Button variant="ghost" size="icon" className="web-sidebar-toggle"
    aria-expanded={expanded} aria-controls="web-sidebar" aria-label={label('Sidebar')} title={label(expanded ? 'Collapse sidebar' : 'Expand sidebar')}
    onClick={() => {
      setSidebar(!expanded);
      try { localStorage.setItem('agent-hub-sidebar', expanded ? 'collapsed' : 'expanded'); } catch { /* Keep the in-memory choice. */ }
    }}><PanelLeft size={18} /></Button>;
  const headerControls = <div className="web-controls web-header-controls">
    {updateAvailable && <Button className="web-update" size="sm" disabled={appUpdate.updating} onClick={() => void appUpdate.activate()}
      aria-label={label(appUpdate.updating ? 'Updating app' : 'Update app')} title={label(appUpdate.updating ? 'Updating app' : 'Update app')}>
      <Download size={16} aria-hidden="true" /><span>{label(appUpdate.updating ? 'Updating app' : 'Update app')}</span>
    </Button>}
    <span className="web-connection" title={label(connection)}><span className={live.connection === 'connected' ? 'online' : ''} /><span>{label(connection)}</span></span>
    <Button variant="ghost" size="icon" onClick={() => setRefresh(value => value + 1)}
      aria-label={label('Refresh data')} title={label('Refresh data')}><RefreshCw size={16} /></Button>
  </div>;
  const fixtureBadge = health.value?.mode === 'fixture' && <span className="web-fixture">{label('Fixture data')}</span>;

  /** Aligns the current record name, status and actions above both detail views; sessions lead with their phase. */
  const compactHeader: DetailHeading = (name, status, model, options) => <header className="web-detail-header">
    <div className="web-detail-heading" data-status-first={options?.statusFirst || undefined}>
      <div className="web-detail-actions">
        {sidebarToggle}
        <Button variant="ghost" size="icon" className="web-list-toggle"
          aria-expanded={listVisible} aria-controls="web-inventory" aria-label={label('Inventory')}
          title={label(listVisible ? 'Hide list' : 'Show list')} onClick={() => setListVisible(value => !value)}><List size={18} /></Button>
        {backLink}
      </div>
      {options?.statusFirst && status}
      <h1 ref={heading} tabIndex={-1} title={name}>{name || fallbackTitle}</h1>
      {!options?.statusFirst && status}
      {model && <span className="web-heading-model" title={model}>{model}</span>}
      {headerControls}
    </div>
    <div className="web-detail-identity">
      {id && <CopyId key={id} id={id} />}
      {model && <span className="web-mobile-model" title={model}>{model}</span>}
      {fixtureBadge}
    </div>
  </header>;
  const header = <div className={id ? 'web-heading web-heading-detail' : 'web-heading'}>
    <div className="web-heading-title">
      {backLink}
      <div className="web-title-line">{sidebarToggle}<h1 ref={heading} tabIndex={-1}>{id ? fallbackTitle : label(title)}</h1></div>
      {fixtureBadge}
    </div>
    {headerControls}
  </div>;

  return <Navigation.Provider value={go}><HeldContext.Provider value={alarm}><LiveContext.Provider value={{ ...live, refresh, unreachable, reportRead, requestRefresh: () => setRefresh(value => value + 1) }}>
    <div className="web-shell" data-sidebar={expanded ? 'expanded' : 'collapsed'} data-immersive={immersive || undefined}>
      <a className="skip-link" href="#web-main">{label('Skip to content')}</a>
      <TooltipProvider delayDuration={250}><aside className="web-rail" id="web-sidebar">
        <RailHint label="Agent Hub"><Link className="web-brand" href="/" aria-label="Agent Hub" data-focus-key="brand"><span><Activity size={20} /></span><strong>Agent Hub</strong></Link></RailHint>
        <nav aria-label={label('Navigation')}>
          {navigation.map(([key, path, name, Icon]) => <RailHint key={key} label={label(name)}><Link href={path} data-focus-key={key} aria-label={label(name)}
            aria-current={key === kind || (key === 'overview' && kind === 'incidents') ? 'page' : undefined}>
            <Icon size={18} aria-hidden="true" /><span>{label(name)}</span>
          </Link></RailHint>)}
        </nav>
        <div className="web-preferences">
          <Dialog open={settings} onOpenChange={setSettings}>
            <RailHint label={label('Settings')}><DialogTrigger asChild><Button className="web-settings-trigger" variant="ghost" aria-label={label('Settings')}>
              <Settings size={18} aria-hidden="true" /><span>{label('Settings')}</span>
            </Button></DialogTrigger></RailHint>
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
              {viewport && <p className="web-viewport-facts">{label('Screen')} {viewport.screenWidth}×{viewport.screenHeight} · {label('Window')} {viewport.innerWidth}×{viewport.innerHeight} · ↑{viewport.insetTop} ↓{viewport.insetBottom} · {label('Gap')} {viewport.bottomGap}{viewport.standalone ? ' · PWA' : ''}</p>}
              <div><DialogClose asChild><Button>{label('Done')}</Button></DialogClose></div>
            </DialogContent>
          </Dialog>
        </div>
      </aside></TooltipProvider>
      <main id="web-main" className="web-main" tabIndex={-1}>
        {!immersive && header}
        <HeldAlert alarm={alarm} stale={heldSummary.stale} />
        {unreachable && <p className="web-warning web-offline" role="status">{label('Offline shell')}</p>}
        {appUpdate.error && <p className="web-warning" role="status">{label('Update failed')}</p>}
        <div ref={page} className="web-page" tabIndex={inventory ? undefined : 0}>
        {inventory ? <div className={'web-split' + (id ? ' web-has-detail' : '') + (immersive && !listVisible ? ' web-list-collapsed' : '')}>
          <section id="web-inventory" ref={list} tabIndex={0} className="web-list-pane" aria-label={label(title)}>
            <InventoryList key={inventory} kind={inventory as Inventory} query={query} id={id} now={Math.max(now, lastRead ?? 0)} update={update} />
          </section>
          {id && <section ref={detail} tabIndex={immersive ? undefined : 0} className="web-detail-pane" aria-label={label('Details')} key={kind + ':' + id + ':' + query.get('execution')}>
            {inventory === 'sessions' ? <SessionDetails id={id} execution={query.get('execution')} tab={tab} tabs={tabs} heading={compactHeader} now={Math.max(now, lastRead ?? 0)} />
              : inventory === 'pools' ? <PoolDetails id={id} tab={tab} tabs={tabs} heading={compactHeader} proposal={query.get('proposal')} select={proposal => update({ proposal }, true)} />
              : <WorktreeDetails id={id} />}
          </section>}
        </div> : <>
          {kind === 'incidents' && <Period query={query} update={update} />}
          {kind === 'overview' ? <Overview query={query} now={Math.max(now, lastRead ?? 0)}
            filter={<div className="web-overview-period"><Expand title={label('Period filter') + (query.has('from') || query.has('to') ? ' · ' + label('Filtered') : '')}>
              <Period query={query} update={update} />
            </Expand></div>} /> : kind === 'incidents'
            ? <Incidents query={query} next={cursor => update({ cursor }, true)} /> : <Quota now={Math.max(now, lastRead ?? 0)} account={query.get('account')} />}
        </>}
        </div>
        {!immersive && <footer className="web-footer">
          <span>Hub {webVersion}</span>
          <span>{label('Server version')} {serverRelease ?? '—'}</span>
          <span>{label(connection)}</span>
          <span title={lastRead ? clock(lastRead) : undefined}>{label('Updated')} {lastRead ?
            relativeTime(lastRead, Math.max(now, lastRead), tag) : '—'}</span>
        </footer>}
      </main>
    </div>
  </LiveContext.Provider></HeldContext.Provider></Navigation.Provider>;
}

