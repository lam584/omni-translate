import { useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { Outlet, useLocation } from 'react-router-dom';
import { brandContent, navItems } from '../../defaults/app-content';
import { resolveRuntimeBridgeStatus } from '../../runtime/runtime-status';
import { useAppStore } from '../../stores/app-store';
import AppIcon, { type AppIconName } from '../icons/AppIcon';
import RuntimeToastHost from './RuntimeToastHost';
import StatusBadge from '../page/StatusBadge';
import type { StatusTone } from '../page/StatusBadge';

function getRuntimeTone(bridgeState: string, bridgeStatus: string): StatusTone {
  if (bridgeState === 'running' || bridgeStatus === 'tauri-shell') {
    return 'ready';
  }

  if (bridgeStatus === 'runtime-error') {
    return 'warning';
  }

  return 'pending';
}

export const appLayoutTestHelpers = {
  getRuntimeTone,
};

type ShellNavItem = {
  id: string;
  path: string;
  label: string;
  hint: string;
  icon: AppIconName;
  badge?: string;
};

function AppLayout() {
  const { t } = useTranslation();
  const location = useLocation();
  const runtimeSnapshot = useAppStore((state) => state.runtimeSnapshot);
  const runtimeNotifications = useAppStore((state) => state.runtimeNotifications);
  const setActivePageByPath = useAppStore((state) => state.setActivePageByPath);
  const effectiveBridgeStatus = resolveRuntimeBridgeStatus(runtimeSnapshot);

  useEffect(() => {
    setActivePageByPath(location.pathname);
  }, [location.pathname, setActivePageByPath]);

  const formatBridgeStatusLabel = (bridgeStatus: string) => {
    if (bridgeStatus === 'tauri-shell') return t('bridgeStatus.tauriShell');
    if (bridgeStatus === 'runtime-error') return t('bridgeStatus.runtimeError');
    return t('bridgeStatus.browserPreview');
  };

  const navLabelByKey: Record<string, { label: string; hint: string; icon: AppIconName }> = {
    session: { label: t('nav.session'), hint: t('nav.sessionHint'), icon: 'mic' },
    'audio-routing': { label: t('nav.audioRouting'), hint: t('nav.audioRoutingHint'), icon: 'route' },
    glossary: { label: t('nav.glossary'), hint: t('nav.glossaryHint'), icon: 'book' },
    history: { label: t('nav.history'), hint: t('nav.historyHint'), icon: 'clock' },
    diagnostics: { label: t('nav.diagnostics'), hint: t('nav.diagnosticsHint'), icon: 'diagnostics' },
  };

  const baseNav: ShellNavItem[] = navItems.map((item) => {
    const meta = navLabelByKey[item.id] ?? { label: item.label, hint: item.hint, icon: 'panel' as AppIconName };
    const shell: ShellNavItem = { id: item.id, path: item.path, label: meta.label, hint: meta.hint, icon: meta.icon };

    if (item.id === 'diagnostics') {
      const count = runtimeNotifications.filter((note) => note.level !== 'info').length;
      if (count > 0) {
        shell.badge = `${count}`;
      }
    }

    return shell;
  });

  const shellNavItems: ShellNavItem[] = [
    ...baseNav,
    {
      id: 'settings',
      path: '/settings',
      label: t('nav.settings'),
      hint: t('nav.settingsHint'),
      icon: 'settings',
    },
  ];

  // Resolve active top-level nav by exact match first, then fall back to a
  // prefix match so nested routes like /settings/providers keep the parent
  // (Settings) item highlighted in the sidebar.
  const exactMatch = shellNavItems.find((item) => item.path === location.pathname);
  const prefixMatch = shellNavItems
    .filter((item) => item.path !== '/' && location.pathname.startsWith(`${item.path}/`))
    .sort((a, b) => b.path.length - a.path.length)[0];
  const activeNav = exactMatch ?? prefixMatch ?? shellNavItems[0];

  // Top-bar title/hint: by default mirrors the active sidebar item, but some
  // nested routes display their own heading instead of the parent.
  const subRouteHeading: { label: string; hint: string; icon: AppIconName } | null =
    location.pathname.startsWith('/settings/overlay-style')
      ? { label: t('settings.sectionOverlay'), hint: t('settings.overlayHint'), icon: 'subtitles' }
      :
    location.pathname.startsWith('/settings/providers')
      ? { label: t('nav.providers'), hint: t('nav.providersHint'), icon: 'server' }
      : null;
  const activePage = subRouteHeading
    ? { ...activeNav, label: subRouteHeading.label, hint: subRouteHeading.hint, icon: subRouteHeading.icon }
    : activeNav;

  return (
    <div className="console-shell">
      <aside className="console-nav" aria-label={t('nav.ariaMain')}>
        <div className="console-brand-card">
          <div className="console-brand-mark">
            <AppIcon name="spark" size={18} />
          </div>
          <div className="console-brand-copy">
            <p>{brandContent.eyebrow || t('brand.kicker')}</p>
            <strong>{t('brand.title')}</strong>
            {brandContent.copy ? <span>{brandContent.copy}</span> : null}
          </div>
        </div>

        <div className="console-section-title">
          <span>{t('nav.sectionMain')}</span>
        </div>
        <nav className="console-nav-list">
          {shellNavItems.map((item) => {
            const classNames = ['console-nav-item'];
            if (item.id === 'settings') classNames.push('console-nav-item-settings');
            if (activeNav.id === item.id) classNames.push('console-nav-item-active');

            return (
            <a
              className={classNames.join(' ')}
              href={`#${item.path}`}
              key={item.id}
              title={item.label}
            >
              <span className="console-nav-icon" aria-hidden="true">
                <AppIcon name={item.icon} size={18} />
              </span>
              <span className="console-nav-copy">
                <strong>{item.label}</strong>
                {item.hint ? <small>{item.hint}</small> : null}
              </span>
              {item.badge ? <span className="console-nav-badge">{item.badge}</span> : null}
            </a>
            );
          })}
        </nav>
      </aside>

      <div className="console-body">
        <header className="console-topbar">
          <div className="console-page-heading">
            <div className="console-page-title-row">
              <div className="console-page-title">
                <span className="console-page-title-icon" aria-hidden="true">
                  <AppIcon name={activePage.icon} size={18} />
                </span>
                <h1>{activePage.label}</h1>
              </div>
              <StatusBadge label={formatBridgeStatusLabel(effectiveBridgeStatus)} tone={getRuntimeTone(runtimeSnapshot.bridge.bridgeState, effectiveBridgeStatus)} />
            </div>
            {activePage.hint ? <p>{activePage.hint}</p> : null}
          </div>
        </header>

        <main className="control-workspace">
          <Outlet />
        </main>
      </div>

      <RuntimeToastHost />
    </div>
  );
}

export default AppLayout;
