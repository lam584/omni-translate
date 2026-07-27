import { useState } from 'react';
import i18n from '../../i18n/config';
import type { DiagnosticsLogLevel } from '../../runtime/desktop-api-v2';
import { useDesktopApiV2 } from '../../runtime/desktop-api-context';
import { createLogger } from '../../runtime/logger';

const logger = createLogger('runtime');

const LOG_LEVELS: readonly DiagnosticsLogLevel[] = ['error', 'warning', 'info', 'debug', 'verbose'];

/**
 * Dynamic log level control wired to the native `set_diagnostics_log_level`
 * command: one level gates both backend pipelines (`log::` facade + `log_*!`
 * diagnostics macros). Defaults follow the backend (debug builds `verbose`,
 * release builds `info`, both overridable via `OMNI_LOG_LEVEL`).
 */
export function LogLevelControl() {
  const desktopApi = useDesktopApiV2();
  const [level, setLevel] = useState<DiagnosticsLogLevel | ''>('');
  const [applyState, setApplyState] = useState<'idle' | 'applied' | 'failed'>('idle');
  const [applyError, setApplyError] = useState<string | null>(null);
  const [retryLevel, setRetryLevel] = useState<DiagnosticsLogLevel | null>(null);

  const applyLevel = async (nextLevel: DiagnosticsLogLevel) => {
    const previousLevel = level;
    setLevel(nextLevel);
    setApplyError(null);
    try {
      await desktopApi.diagnostics.setLogLevel(nextLevel);
      setApplyState('applied');
      setRetryLevel(null);
      logger.info('diagnostics log level changed', `level=${nextLevel}`);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      setLevel(previousLevel);
      setApplyState('failed');
      setApplyError(detail);
      setRetryLevel(nextLevel);
      logger.error(
        'set_diagnostics_log_level failed',
        detail,
      );
    }
  };

  return (
    <div className="diagnostics-benchmark-row" data-testid="log-level-control">
      <label className="diagnostics-benchmark-label" htmlFor="diagnostics-log-level">
        {i18n.t('diagnostics.logLevel.label', { defaultValue: '日志级别' })}
      </label>
      <select
        id="diagnostics-log-level"
        className="diagnostics-benchmark-select"
        value={level}
        onChange={(event) => void applyLevel(event.target.value as DiagnosticsLogLevel)}
      >
        <option value="" disabled>
          {i18n.t('diagnostics.logLevel.placeholder', { defaultValue: '跟随默认（可动态调整）' })}
        </option>
        {LOG_LEVELS.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
      {applyState === 'applied' ? (
        <span aria-live="polite">
          {i18n.t('diagnostics.logLevel.applied', { defaultValue: '已生效' })}
        </span>
      ) : null}
      {applyState === 'failed' ? (
        <span aria-live="polite" role="alert">
          {i18n.t('diagnostics.logLevel.failed', { defaultValue: '日志级别切换失败，请刷新运行时后重试' })}
          {applyError ? `：${applyError}` : ''}
          {retryLevel ? (
            <button className="icon-button" onClick={() => void applyLevel(retryLevel)} type="button">
              {i18n.t('common.retry')}
            </button>
          ) : null}
        </span>
      ) : null}
    </div>
  );
}
