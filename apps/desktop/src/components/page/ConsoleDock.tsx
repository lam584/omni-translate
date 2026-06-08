import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';

export type ConsoleDockSection = {
  id: string;
  token: string;
  label: string;
};

type ConsoleDockProps = {
  title: string;
  sections: readonly ConsoleDockSection[];
  activeSectionId: string;
  collapsedSections: Record<string, boolean>;
  onSelectSection: (sectionId: string) => void;
  onToggleSection: (sectionId: string) => void;
  onExpandAll: () => void;
  onCollapseAll: () => void;
};

type ConsoleLaneProps = {
  id: string;
  token: string;
  label: string;
  collapsed: boolean;
  layoutClassName: string;
  onExpand: () => void;
  children: React.ReactNode;
};

export function scrollToConsoleSection(
  sectionId: string,
  targetWindow: Window | undefined = typeof window === 'undefined' ? undefined : window,
  targetDocument: Document | undefined = typeof document === 'undefined' ? undefined : document,
) {
  if (!targetWindow || !targetDocument) {
    return false;
  }

  const target = targetDocument.getElementById(sectionId);
  if (!target) {
    return false;
  }

  target.scrollIntoView({ behavior: 'smooth', block: 'start' });
  targetWindow.history.replaceState(null, '', `#${sectionId}`);
  return true;
}

export function useConsoleDock(sections: readonly ConsoleDockSection[]) {
  const idsKey = useMemo(() => sections.map((section) => section.id).join('|'), [sections]);
  const [activeSectionId, setActiveSectionId] = useState(sections[0]?.id ?? '');
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(sections.map((section) => [section.id, false])),
  );

  useEffect(() => {
    queueMicrotask(() => {
      setActiveSectionId((current) => current || sections[0]?.id || '');
      setCollapsedSections((current) => {
        const next = Object.fromEntries(sections.map((section) => [section.id, current[section.id] ?? false]));
        return next;
      });
    });
  }, [idsKey, sections]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof document === 'undefined' || sections.length === 0) {
      return;
    }

    const elements = sections
      .map((section) => document.getElementById(section.id))
      .filter((element): element is HTMLElement => element instanceof HTMLElement);

    if (elements.length === 0) {
      return;
    }

    const observer = new IntersectionObserver(
      (entries) => {
        const current = entries
          .filter((entry) => entry.isIntersecting)
          .sort((left, right) => right.intersectionRatio - left.intersectionRatio)[0];

        if (current) {
          setActiveSectionId(current.target.id);
        }
      },
      {
        rootMargin: '-18% 0px -54% 0px',
        threshold: [0.12, 0.32, 0.56],
      },
    );

    elements.forEach((element) => observer.observe(element));

    return () => observer.disconnect();
  }, [idsKey, sections]);

  const selectSection = (sectionId: string) => {
    if (!scrollToConsoleSection(sectionId)) {
      return;
    }

    setActiveSectionId(sectionId);
  };

  const toggleSection = (sectionId: string) => {
    setCollapsedSections((current) => ({
      ...current,
      [sectionId]: !current[sectionId],
    }));
  };

  const expandSection = (sectionId: string) => {
    setCollapsedSections((current) => ({
      ...current,
      [sectionId]: false,
    }));
  };

  const expandAllSections = () => {
    setCollapsedSections(Object.fromEntries(sections.map((section) => [section.id, false])));
  };

  const collapseAllSections = () => {
    setCollapsedSections(Object.fromEntries(sections.map((section) => [section.id, true])));
  };

  return {
    activeSectionId,
    collapsedSections,
    collapseAllSections,
    expandAllSections,
    expandSection,
    selectSection,
    toggleSection,
  };
}

function ConsoleDock({
  title,
  sections,
  activeSectionId,
  collapsedSections,
  onSelectSection,
  onToggleSection,
  onExpandAll,
  onCollapseAll,
}: ConsoleDockProps) {
  const { t } = useTranslation();

  return (
    <section className="console-dock sticky-toolbar">
      <div className="console-dock-header">
        <div className="console-dock-title">
          <span className="panel-token">NAV</span>
          <strong>{title}</strong>
        </div>
        <div className="console-dock-actions">
          <button className="action-button" onClick={onExpandAll} type="button">
            {t('consoleDock.expandAll')}
          </button>
          <button className="action-button" onClick={onCollapseAll} type="button">
            {t('consoleDock.collapseAll')}
          </button>
        </div>
      </div>

      <div className="console-dock-nav">
        {sections.map((section) => {
          const selected = activeSectionId === section.id;
          const collapsed = collapsedSections[section.id] ?? false;

          return (
            <div className="console-dock-item" key={section.id}>
              <button
                className={selected ? 'console-dock-anchor console-dock-anchor-active' : 'console-dock-anchor'}
                onClick={() => onSelectSection(section.id)}
                type="button"
              >
                <span className="panel-token">{section.token}</span>
                <span>{section.label}</span>
              </button>
              <button className="console-dock-toggle" onClick={() => onToggleSection(section.id)} type="button">
                {collapsed ? t('consoleDock.expand') : t('consoleDock.collapse')}
              </button>
            </div>
          );
        })}
      </div>
    </section>
  );
}

function ConsoleLane({ id, token, label, collapsed, layoutClassName, onExpand, children }: ConsoleLaneProps) {
  const { t } = useTranslation();

  return (
    <section className={collapsed ? 'console-lane console-lane-collapsed' : 'console-lane'} id={id}>
      {collapsed ? (
        <div className="console-lane-bar">
          <div className="console-lane-meta">
            <span className="panel-token">{token}</span>
            <strong>{label}</strong>
          </div>
          <button className="action-button" onClick={onExpand} type="button">
            {t('consoleDock.expandSection')}
          </button>
        </div>
      ) : (
        <div className={layoutClassName}>{children}</div>
      )}
    </section>
  );
}

export { ConsoleDock, ConsoleLane };
