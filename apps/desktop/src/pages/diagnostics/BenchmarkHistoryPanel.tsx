import i18n from '../../i18n/config';
import AppIcon from '../../components/icons/AppIcon';
import type { BenchmarkHistorySummary } from './benchmarkHistory';
import { formatHistoryTime, historyScore } from './benchmarkHistoryFormat';

export function BenchmarkHistoryPanel({
  error,
  hasMore,
  loading,
  onLoadMore,
  records,
  totalCount,
  onClear,
  onDelete,
  onOpen,
  onRefresh,
}: {
  error: string | null;
  hasMore: boolean;
  loading: boolean;
  onLoadMore: () => void;
  records: BenchmarkHistorySummary[];
  totalCount: number;
  onClear: () => void;
  onDelete: (recordId: string) => void;
  onOpen: (recordId: string) => void;
  onRefresh: () => void;
}) {
  return (
    <section className="benchmark-history" aria-label={i18n.t('diagnostics.benchmark.historyTitle')}>
      <div className="benchmark-history-head">
        <div>
          <h3>{i18n.t('diagnostics.benchmark.historyTitle')}</h3>
          <p>{i18n.t('diagnostics.benchmark.historyDescription', { count: totalCount })}</p>
        </div>
        <div className="benchmark-history-actions">
          <button disabled={loading} onClick={onRefresh} type="button"><AppIcon name="refresh" size={13} />{i18n.t('diagnostics.actions.refreshRuntime')}</button>
          <button disabled={loading || records.length === 0} onClick={onClear} type="button"><AppIcon name="trash" size={13} />{i18n.t('diagnostics.benchmark.clearHistory')}</button>
        </div>
      </div>
      {error ? <p className="benchmark-warning" role="alert">{error}</p> : null}
      {records.length === 0 && !loading ? <p className="benchmark-history-empty">{i18n.t('diagnostics.benchmark.historyEmpty')}</p> : null}
      {records.length > 0 ? (
        <>
          <div className="benchmark-history-list">
            {records.map((record) => (
              <article className="benchmark-history-row" key={record.recordId}>
                <button className="benchmark-history-open" onClick={() => onOpen(record.recordId)} type="button">
                  <strong>{record.model}</strong>
                  <span>{formatHistoryTime(record.createdAt)}</span>
                  <small>{i18n.t('diagnostics.benchmark.historyStatus', { run: record.runStatus, score: record.scoreStatus })}</small>
                </button>
                <strong className="benchmark-history-score">{historyScore(record)}</strong>
                <button aria-label={i18n.t('diagnostics.benchmark.deleteHistory')} disabled={loading} onClick={() => onDelete(record.recordId)} type="button"><AppIcon name="trash" size={13} /></button>
              </article>
            ))}
          </div>
          {hasMore ? <button className="benchmark-history-more" disabled={loading} onClick={onLoadMore} type="button"><AppIcon name="plus" size={13} />{i18n.t('diagnostics.benchmark.loadMoreHistory')}</button> : null}
        </>
      ) : null}
    </section>
  );
}
