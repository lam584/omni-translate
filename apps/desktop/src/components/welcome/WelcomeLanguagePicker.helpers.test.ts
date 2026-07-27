import { describe, expect, it } from 'vitest';
import { welcomeLanguagePickerHelpers } from './WelcomeLanguagePicker';

const translate = (key: string) => key;

describe('welcomeLanguagePickerHelpers', () => {
  it('formats provider setup failures for each runtime error shape', () => {
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError({ code: 'timeout', operation: 'credential-save' }, translate)).toBe('welcome.apiKeySaveInvokeTimeout');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError({ code: 'timeout', operation: 'provider-probe' }, translate)).toBe('welcome.apiKeyProbeTimeout');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError({ code: null, operation: null }, translate)).toBe('welcome.apiKeyProbeFailed');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError(new Error('401 unauthorized'), translate)).toBe('session.errorCode.credentialInvalid');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError('429 quota exhausted', translate)).toBe('session.errorCode.quotaExceeded');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError(new Error('network connection failed'), translate)).toBe('session.errorCode.networkUnreachable');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError('opaque failure', translate)).toBe('welcome.apiKeyProbeFailed');
    expect(welcomeLanguagePickerHelpers.formatProviderSetupError(null, translate)).toBe('welcome.apiKeyProbeFailed');
  });
});
