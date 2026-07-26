import { useTranslation } from 'react-i18next';

type ChainFlowProps = {
  direction: 'inbound' | 'outbound';
  directionLabel?: string;
  inboundLabel: string;
  inboundSubtitle?: string;
  modelLabel: string;
  outboundLabel: string;
  modelSubtitle?: string;
  outboundSubtitle?: string;
};

export default function ChainFlow({
  direction,
  directionLabel,
  inboundLabel,
  inboundSubtitle,
  modelLabel,
  outboundLabel,
  modelSubtitle,
  outboundSubtitle,
}: ChainFlowProps) {
  const { t } = useTranslation();
  return (
    <div className={['chain-flow', direction === 'outbound' ? 'chain-flow-outbound' : 'chain-flow-inbound'].join(' ')}>
      <div className="chain-flow-direction">{directionLabel ?? (direction === 'inbound' ? t('audioRouting.directionListen') : t('audioRouting.directionSpeak'))}</div>
      <div className="chain-flow-segment">
        <div className="chain-flow-segment-label">{inboundLabel}</div>
        {inboundSubtitle ? <div className="chain-flow-segment-sub">{inboundSubtitle}</div> : null}
      </div>
      <span className="chain-flow-arrow" aria-hidden="true">—</span>
      <div className="chain-flow-segment">
        <div className="chain-flow-segment-label">{modelLabel}</div>
        {modelSubtitle ? <div className="chain-flow-segment-sub">{modelSubtitle}</div> : null}
      </div>
      <span className="chain-flow-arrow" aria-hidden="true">—</span>
      <div className="chain-flow-segment">
        <div className="chain-flow-segment-label">{outboundLabel}</div>
        {outboundSubtitle ? <div className="chain-flow-segment-sub">{outboundSubtitle}</div> : null}
      </div>
    </div>
  );
}
