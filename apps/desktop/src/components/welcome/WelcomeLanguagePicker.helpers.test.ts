import { describe, expect, it } from 'vitest';
import { welcomeLanguagePickerHelpers } from './WelcomeLanguagePicker';

const translate = (key: string) => key;

describe('welcomeLanguagePickerHelpers', () => {
  it('formats provider setup failures for each runtime error shape', () => {
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError({ code: 'timeout', operation: 'credential-save' }, translate)).toBe('welcome.apiKeySaveInvokeTimeout');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError({ code: 'timeout', operation: 'provider-probe' }, translate)).toBe('welcome.apiKeyProbeTimeout');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError({ code: null, operation: null }, translate)).toBe('welcome.apiKeyProbeFailed');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError(new Error('backend unavailable'), translate)).toBe('backend unavailable');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError('string failure', translate)).toBe('string failure');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError(null, translate)).toBe('welcome.apiKeyProbeFailed');
  });
});
