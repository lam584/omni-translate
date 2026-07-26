import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { useTranslation } from 'react-i18next';
import AppIcon, { type AppIconName } from '../../components/icons/AppIcon';
import zhCN from '../../i18n/locales/zh-CN.json';
import { optionDomId, resolveSelectedModel, type RoutingModelOption, type ScenarioCapability } from './routingModelCatalog';

export function resolveChineseFallback(key: string): string {
  let value: unknown = zhCN;
  for (const segment of key.split('.')) {
    if (!value || typeof value !== 'object' || !(segment in value)) return key;
    value = (value as Record<string, unknown>)[segment];
  }
  return typeof value === 'string' ? value : key;
}

export function tWithDefault(t: (key: string, options?: { defaultValue?: string }) => string, key: string): string {
  return t(key, { defaultValue: resolveChineseFallback(key) });
}

export type ScenarioCardProps = {
  icon: AppIconName;
  title: string;
  caption: string;
  modelName: string;
  modelProvider: string;
  tags: ScenarioCapability[];
  modelOptions: RoutingModelOption[];
  value: string;
  onSelect: (modelId: string) => void;
  muted?: boolean;
  mutedHint?: string;
  active?: boolean;
  enabled?: boolean;
  onEnabledChange?: (enabled: boolean) => void;
  enableLabel?: string;
  enableChecked?: boolean;
};

export default function ScenarioCard(props: ScenarioCardProps) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  const cardRef = useRef<HTMLDivElement | null>(null);
  const selected = resolveSelectedModel(props.modelOptions, props.value);
  const enabled = props.enabled ?? true;
  const tagLabels: Record<ScenarioCapability, string> = {
    stt: tWithDefault(t, 'audioRouting.tagStt'), translation: tWithDefault(t, 'audioRouting.tagTranslation'),
    subtitle: tWithDefault(t, 'audioRouting.tagSubtitle'), speech: tWithDefault(t, 'audioRouting.tagSpeech'),
    tts: tWithDefault(t, 'audioRouting.tagTts'),
  };

  useEffect(() => {
    if (!open) return undefined;
    const closeOutside = (event: MouseEvent) => {
      if (cardRef.current && !cardRef.current.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', closeOutside);
    return () => document.removeEventListener('mousedown', closeOutside);
  }, [open]);

  const select = (index: number) => {
    const option = props.modelOptions[index]!;
    props.onSelect(option.model);
    setOpen(false);
  };
  const handleButtonKey = (event: KeyboardEvent<HTMLButtonElement>) => {
    if (['ArrowDown', 'Enter', ' '].includes(event.key)) {
      event.preventDefault();
      setActiveIndex(Math.max(0, props.modelOptions.findIndex((option) => option.model === props.value)));
      setOpen(true);
      return;
    }
    if (event.key === 'Escape') setOpen(false);
  };
  const handleListKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!props.modelOptions.length) return;
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const delta = event.key === 'ArrowDown' ? 1 : -1;
      setActiveIndex((current) => (current + delta + props.modelOptions.length) % props.modelOptions.length);
    } else if (event.key === 'Home') { event.preventDefault(); setActiveIndex(0); }
    else if (event.key === 'End') { event.preventDefault(); setActiveIndex(props.modelOptions.length - 1); }
    else if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); select(activeIndex); }
    else if (event.key === 'Escape') { event.preventDefault(); setOpen(false); }
  };
  const activeDescendant = open && props.modelOptions[activeIndex]
    ? `scenario-option-${optionDomId(props.modelOptions[activeIndex]!.model)}` : undefined;
  const toggleChecked = props.enableChecked ?? enabled;

  return <div className={['scenario-card', !enabled || props.muted ? 'scenario-card-muted' : '', props.active ? 'scenario-card-active' : '', open ? 'scenario-card-open' : ''].filter(Boolean).join(' ')} ref={cardRef}>
    <div className="scenario-card-head">
      <div className="scenario-card-icon" aria-hidden="true"><AppIcon name={props.icon} size={16} /></div>
      <div className="scenario-card-titles"><h4>{props.title}</h4><span>{props.caption}</span></div>
      {props.onEnabledChange ? <label className={['scenario-card-toggle', toggleChecked ? 'scenario-card-toggle-on' : ''].join(' ')}>
        <input aria-checked={toggleChecked} checked={toggleChecked} className="ui-switch" onChange={(event) => props.onEnabledChange?.(event.target.checked)} role="switch" type="checkbox" />
        <span>{props.enableLabel ?? ''}</span>
      </label> : null}
    </div>
    <div className="scenario-card-control">
      <button aria-activedescendant={activeDescendant} aria-expanded={open} aria-haspopup="listbox" className="scenario-card-selector" disabled={!enabled || props.muted} onClick={() => setOpen((value) => !value)} onKeyDown={handleButtonKey} role="combobox" type="button">
        <div className="scenario-card-model"><strong>{(selected?.displayName ?? props.modelName) || '—'}</strong><small>{selected?.description ?? props.modelProvider}</small></div>
        <span className="scenario-card-caret" aria-hidden="true">▾</span>
      </button>
      {open && enabled && !props.muted ? <div aria-activedescendant={activeDescendant} className="scenario-card-list" onKeyDown={handleListKey} role="listbox" tabIndex={-1}>
        {!props.modelOptions.length ? <div className="routing-empty">{tWithDefault(t, 'audioRouting.noProviderModels')}</div> : props.modelOptions.map((option, index) =>
          <button aria-selected={option.model === props.value} className={['scenario-card-option', option.model === props.value ? 'scenario-card-option-active' : '', index === activeIndex ? 'scenario-card-option-focused' : ''].filter(Boolean).join(' ')} data-value={option.model} id={`scenario-option-${optionDomId(option.model)}`} key={option.model} onClick={() => select(index)} onMouseEnter={() => setActiveIndex(index)} role="option" type="button">
            <AppIcon className="scenario-card-option-check" name="check" size={12} /><span className="scenario-card-option-name">{option.displayName}</span>
          </button>)}
      </div> : null}
      {(!enabled || props.muted) && props.mutedHint ? <p className="scenario-card-hint">{props.mutedHint}</p> : null}
      {props.tags.length ? <div className="scenario-card-tags">{props.tags.map((tag) => <span className={['scenario-card-tag', `scenario-card-tag-${tag}`, !enabled || props.muted ? 'scenario-card-tag-muted' : ''].join(' ')} key={tag}><AppIcon name="check" size={11} />{tagLabels[tag]}</span>)}</div> : null}
    </div>
  </div>;
}
